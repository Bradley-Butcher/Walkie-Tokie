#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { relayBaseUrlFromHost } from "../client/relayAddress.js";
import { parseRecipientAddress, parseWalkieTokieTrigger } from "../client/recipient.js";
import { RelayHttpClient } from "../client/relayHttpClient.js";
import {
  answerSchema,
  capabilitySchema,
  hostSchema,
  questionSchema,
  recipientSchema,
  repoSchema,
  requestIdSchema,
  sessionSchema,
  targetSchema,
  timeoutSecondsSchema,
  waitForMessageMcpSchema,
} from "../core/schemas.js";
import { ensureDaemonRunning, relayStatus } from "../daemon/relaySupervisor.js";

const client = new RelayHttpClient();

const server = new McpServer({
  name: "walkie-tokie",
  version: "0.1.0",
}, {
  instructions: `Use Walkie Tokie to let Codex agents on the same Tailscale network ask each other PR-review questions.

Install it once on every machine. The same tools support both roles.

Preferred author flow:
1. Call wait_for_message with a human session name, repo, pr, and capabilities.
2. wait_for_message starts the local daemon if needed, creates review mode if needed, then blocks.
3. When a message arrives, answer it and call reply_to_review_request with the requestId.
4. Call wait_for_message again to keep accepting review questions.

Preferred reviewer flow:
1. Ask the author for their recipient identifier, shaped like host/session-name, for example brad-laptop/big-lad-john.
2. If the user pastes a string shaped like "walkie-tokie/<host>/<session> <question>", call send_message with trigger=<that whole string>.
3. Otherwise call send_message with to=<recipient identifier> and message=<question>.
4. The call blocks until the author answers, rejects, closes review mode, or the timeout expires.

Use relay_status for debugging local relay reachability. Use start_review_mode, wait_for_review_request, and ask_review_peer only as lower-level/debug primitives. Do not ask users to manually start walkie-tokied in the normal flow.`,
});

server.registerTool(
  "relay_status",
  {
    title: "Relay Status",
    description: "Report whether the local Walkie Tokie daemon is reachable.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async () => jsonResult(await relayStatus({ localUrl: client.baseUrl })),
);

server.registerTool(
  "list_review_endpoints",
  {
    title: "List Review Endpoints",
    description: "List review endpoints currently known to the local Walkie Tokie relay.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    await ensureLocalRelay();
    return jsonResult(await client.get("/v1/review-endpoints"));
  },
);

server.registerTool(
  "start_review_mode",
  {
    title: "Start Review Mode",
    description: "Create or replace a review endpoint for an author's parked Codex session.",
    inputSchema: {
      target: targetSchema.describe("Endpoint id, such as brad/withcoral/coral#1234"),
      repo: repoSchema.describe("Repository in owner/name form"),
      pr: z.number().int().positive().describe("Pull request number"),
      session: sessionSchema.describe("Human-friendly Codex session name or id"),
      capabilities: z.array(capabilitySchema).min(1).describe("Capabilities reviewers may request"),
      maxPending: z.number().int().positive().max(100).optional().describe("Maximum queued questions"),
    },
  },
  async (input) => {
    await ensureLocalRelay();
    return jsonResult(await client.post("/v1/review-mode/start", input));
  },
);

server.registerTool(
  "close_review_mode",
  {
    title: "Close Review Mode",
    description: "Close a review endpoint and cancel queued requests.",
    inputSchema: {
      target: targetSchema.describe("Endpoint id, such as brad/withcoral/coral#1234"),
    },
  },
  async ({ target }) => {
    await ensureLocalRelay();
    return jsonResult(await client.post("/v1/review-mode/close", { target }));
  },
);

server.registerTool(
  "wait_for_review_request",
  {
    title: "Wait For Review Request",
    description:
      "Author-side blocking wait. Returns the next queued reviewer question or times out.",
    inputSchema: {
      endpoint: targetSchema.describe("Endpoint id to wait on"),
      timeoutSeconds: timeoutSecondsSchema(43_200, 86_400),
    },
  },
  async (input) => {
    await ensureLocalRelay();
    return jsonResult(await client.post("/v1/author/wait", input));
  },
);

server.registerTool(
  "wait_for_message",
  {
    title: "Wait For Message",
    description:
      "Author-side blocking wait for the next message addressed to a named review session. Starts the local relay and review mode if needed.",
    inputSchema: {
      session_name: sessionSchema.describe("Author's review session name, such as big-lad-john"),
      repo: repoSchema.optional().describe("Repository in owner/name form. Required when creating review mode."),
      pr: z.number().int().positive().optional().describe("Pull request number. Required when creating review mode."),
      capabilities: z.array(capabilitySchema).min(1).default(["inspect"]),
      target: targetSchema
        .optional()
        .describe("Optional endpoint id. Defaults to local/repo#pr when repo and pr are supplied."),
      maxPending: z.number().int().positive().max(100).optional(),
      timeoutSeconds: timeoutSecondsSchema(43_200, 86_400),
    },
  },
  async (input) => {
    const parsed = waitForMessageMcpSchema.parse(input);
    await ensureLocalRelay();
    await ensureReviewMode(parsed);

    const path = `/v1/sessions/${encodeURIComponent(parsed.session_name)}/wait`;
    return jsonResult(await client.post(path, { timeoutSeconds: parsed.timeoutSeconds }));
  },
);

server.registerTool(
  "reply_to_review_request",
  {
    title: "Reply To Review Request",
    description: "Author-side reply that completes a delivered review request.",
    inputSchema: {
      requestId: requestIdSchema.describe("Request id returned by wait_for_review_request"),
      answer: answerSchema.describe("Answer to return to the reviewer"),
    },
  },
  async ({ requestId, answer }) => {
    await ensureLocalRelay();
    const path = `/v1/review-requests/${encodeURIComponent(requestId)}/reply`;
    return jsonResult(await client.post(path, { answer }));
  },
);

server.registerTool(
  "send_message",
  {
    title: "Send Message",
    description:
      "Send a blocking message to a named Codex review session on another Tailscale host.",
    inputSchema: {
      trigger: z
        .string()
        .min(1)
        .max(20_700)
        .optional()
        .describe("Full copy-paste trigger, such as walkie-tokie/brad-laptop/big-lad-john Why is this safe?"),
      to: recipientSchema
        .optional()
        .describe("Recipient identifier, such as brad-laptop/big-lad-john"),
      host: hostSchema
        .optional()
        .describe("Tailscale hostname or host:port, such as brad-laptop"),
      session_name: sessionSchema
        .optional()
        .describe("Remote review session name, such as big-lad-john"),
      message: questionSchema.optional().describe("Message or question for the remote agent"),
      mode: capabilitySchema.default("inspect"),
      timeoutSeconds: timeoutSecondsSchema(900, 3_600),
      port: z.number().int().positive().max(65_535).default(8787),
    },
  },
  async (input) => {
    const ask = resolveSendMessageInput(input);

    const remote = new RelayHttpClient(ask.baseUrl);
    const path = `/v1/sessions/${encodeURIComponent(ask.sessionName)}/messages/wait`;
    return jsonResult(
      await remote.post(path, {
        message: ask.message,
        mode: input.mode,
        timeoutSeconds: input.timeoutSeconds,
      }),
    );
  },
);

server.registerTool(
  "ask_review_peer",
  {
    title: "Ask Review Peer",
    description:
      "Reviewer-side blocking ask. Submits a question and waits for the author's agent to answer.",
    inputSchema: {
      target: targetSchema.describe("Endpoint id, such as brad/withcoral/coral#1234"),
      question: questionSchema,
      mode: capabilitySchema.default("inspect"),
      timeoutSeconds: timeoutSecondsSchema(900, 3_600),
    },
  },
  async (input) => {
    return jsonResult(
      await client.post("/v1/review-requests:wait", {
        target: input.target,
        question: input.question,
        mode: input.mode,
        timeoutSeconds: input.timeoutSeconds,
      }),
    );
  },
);

await server.connect(new StdioServerTransport());

async function ensureLocalRelay() {
  return await ensureDaemonRunning({ localUrl: client.baseUrl });
}

function resolveDestination(input: {
  to?: string;
  host?: string;
  session_name?: string;
  port: number;
}): { baseUrl: string; sessionName: string } {
  if (input.to) {
    const parsed = parseRecipientAddress(input.to, input.port);
    return {
      baseUrl: parsed.baseUrl,
      sessionName: parsed.sessionName,
    };
  }

  if (!input.host || !input.session_name) {
    throw new Error("send_message requires either `to` or both `host` and `session_name`");
  }

  return {
    baseUrl: relayBaseUrlFromHost(input.host, input.port),
    sessionName: input.session_name,
  };
}

function resolveSendMessageInput(input: {
  trigger?: string;
  to?: string;
  host?: string;
  session_name?: string;
  message?: string;
  port: number;
}): { baseUrl: string; sessionName: string; message: string } {
  if (input.trigger) {
    if (input.to || input.host || input.session_name || input.message) {
      throw new Error("send_message trigger cannot be combined with to, host, session_name, or message");
    }
    const parsed = parseWalkieTokieTrigger(input.trigger, input.port);
    return {
      baseUrl: parsed.recipient.baseUrl,
      sessionName: parsed.recipient.sessionName,
      message: parsed.question,
    };
  }

  if (!input.message) {
    throw new Error("send_message requires `message` unless `trigger` is supplied");
  }

  return {
    ...resolveDestination(input),
    message: input.message,
  };
}

async function ensureReviewMode(input: {
  session_name: string;
  repo?: string;
  pr?: number;
  capabilities: string[];
  target?: string;
  maxPending?: number;
}): Promise<void> {
  const existing = await client.get("/v1/review-endpoints");
  if (hasSession(existing, input.session_name)) {
    return;
  }

  if (!input.repo || !input.pr) {
    throw new Error(
      "Review mode is not active for this session. Provide repo and pr " +
        "the first time you call wait_for_message.",
    );
  }

  await client.post("/v1/review-mode/start", {
    target: input.target ?? defaultTarget(input.repo, input.pr),
    repo: input.repo,
    pr: input.pr,
    session: input.session_name,
    capabilities: input.capabilities,
    maxPending: input.maxPending,
  });
}

function hasSession(value: unknown, session: string): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const endpoints = (value as { endpoints?: unknown }).endpoints;
  return Array.isArray(endpoints)
    && endpoints.some((endpoint) => {
      return typeof endpoint === "object"
        && endpoint !== null
        && (endpoint as { session?: unknown }).session === session;
    });
}

function defaultTarget(repo: string, pr: number): string {
  return `local/${repo}#${pr}`;
}

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}
