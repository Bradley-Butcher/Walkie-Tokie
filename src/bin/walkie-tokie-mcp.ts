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
  prepareReviewModeMcpSchema,
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
  version: "0.1.3",
}, {
  instructions: `Use Walkie Tokie to let Codex agents on the same Tailscale network ask each other PR-review questions.

Install it once on every machine. The same tools support both roles.

Preferred author flow:
1. Call prepare_review_mode with a human session name and capabilities. Include repo and pr when this is PR-related.
2. Tell the user the returned triggerPrefix and recipient before blocking; this is the string they should share.
3. Call wait_for_message with the same session name and capabilities.
4. When a message arrives, answer it and call reply_to_review_request with the requestId.
5. Call wait_for_message again to keep accepting review questions.

Preferred reviewer flow:
1. Ask the author for their recipient identifier, shaped like host/session-name, for example alice-laptop/review-pr-123.
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
      target: targetSchema.describe("Endpoint id, such as team/example/repo#1234 or session/design-thread"),
      repo: repoSchema.optional().describe("Optional repository in owner/name form"),
      pr: z.number().int().positive().optional().describe("Optional pull request number"),
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
      target: targetSchema.describe("Endpoint id, such as team/example/repo#1234"),
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
  "prepare_review_mode",
  {
    title: "Prepare Review Mode",
    description:
      "Author-side setup. Starts the local relay, creates review mode if needed, and returns the recipient string to share before waiting.",
    inputSchema: {
      session_name: sessionSchema.describe("Author's review session name, such as review-pr-123"),
      repo: repoSchema.optional().describe("Optional repository in owner/name form."),
      pr: z.number().int().positive().optional().describe("Optional pull request number."),
      capabilities: z.array(capabilitySchema).min(1).default(["inspect"]),
      target: targetSchema
        .optional()
        .describe("Optional endpoint id. Defaults to local/repo#pr for PR context, otherwise session/session-name."),
      maxPending: z.number().int().positive().max(100).optional(),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async (input) => {
    const parsed = prepareReviewModeMcpSchema.parse(input);
    const relay = await ensureLocalRelay();
    const reviewMode = await ensureReviewMode(parsed);
    return jsonResult(reviewModeShare(parsed.session_name, relay, reviewMode.created));
  },
);

server.registerTool(
  "wait_for_message",
  {
    title: "Wait For Message",
    description:
      "Author-side blocking wait for the next message addressed to a named review session. Starts the local relay and review mode if needed.",
    inputSchema: {
      session_name: sessionSchema.describe("Author's review session name, such as review-pr-123"),
      repo: repoSchema.optional().describe("Optional repository in owner/name form."),
      pr: z.number().int().positive().optional().describe("Optional pull request number."),
      capabilities: z.array(capabilitySchema).min(1).default(["inspect"]),
      target: targetSchema
        .optional()
        .describe("Optional endpoint id. Defaults to local/repo#pr for PR context, otherwise session/session-name."),
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
        .describe("Full copy-paste trigger, such as walkie-tokie/alice-laptop/review-pr-123 Why is this safe?"),
      to: recipientSchema
        .optional()
        .describe("Recipient identifier, such as alice-laptop/review-pr-123"),
      host: hostSchema
        .optional()
        .describe("Tailscale hostname or host:port, such as alice-laptop"),
      session_name: sessionSchema
        .optional()
        .describe("Remote review session name, such as review-pr-123"),
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
      target: targetSchema.describe("Endpoint id, such as team/example/repo#1234"),
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

function reviewModeShare(
  sessionName: string,
  relay: Awaited<ReturnType<typeof ensureLocalRelay>>,
  created: boolean,
) {
  const host = process.env.WALKIE_TOKIE_PUBLIC_HOST ?? relay.publicHost;
  if (!host) {
    return {
      status: created ? "created" : "ready",
      sessionName,
      recipient: null,
      triggerPrefix: null,
      relay,
      message:
        "Review mode is ready, but Walkie Tokie could not detect a Tailscale host/IP to share. " +
        "Set WALKIE_TOKIE_PUBLIC_HOST to your Tailscale hostname or IPv4 address, then call prepare_review_mode again.",
    };
  }

  const recipient = `${host}/${sessionName}`;
  return {
    status: created ? "created" : "ready",
    sessionName,
    recipient,
    triggerPrefix: `walkie-tokie/${recipient}`,
    relay,
    message: `Share this before waiting: walkie-tokie/${recipient} <question>`,
  };
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
}): Promise<{ created: boolean }> {
  const existing = await client.get("/v1/review-endpoints");
  if (hasSession(existing, input.session_name)) {
    return { created: false };
  }

  await client.post("/v1/review-mode/start", {
    target: input.target ?? defaultTarget(input.session_name, input.repo, input.pr),
    repo: input.repo,
    pr: input.pr,
    session: input.session_name,
    capabilities: input.capabilities,
    maxPending: input.maxPending,
  });
  return { created: true };
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

function defaultTarget(sessionName: string, repo?: string, pr?: number): string {
  if (repo && pr) {
    return `local/${repo}#${pr}`;
  }
  return `session/${slugifySession(sessionName)}`;
}

function slugifySession(sessionName: string): string {
  const slug = sessionName.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "default";
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
