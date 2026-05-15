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
  version: "0.1.6",
}, {
  instructions: `Use Walkie Tokie to let Codex agents on the same Tailscale network ask each other PR-review questions.

Install it once on every machine. The same tools support both roles.

Preferred author flow:
1. Call prepare_review_mode with a human session name and capabilities. Include repo and pr when this is PR-related.
2. Tell the user both returned share strings before blocking: remoteTriggerPrefix for agents on another machine, and localTriggerPrefix for agents on the same machine. Do not share only triggerPrefix; it is a compatibility alias.
3. Call wait_for_message with the same session name and capabilities.
4. When a message arrives, answer it and call reply_to_review_request with the requestId.
5. Immediately call wait_for_message again after every reply, unless the user told you to stop or close review mode. Reviewer agents may have follow-up questions.

Preferred reviewer flow:
1. Ask the author for their recipient identifier, shaped like host/session-name, for example alice-laptop/review-pr-123.
2. If the user pastes a string shaped like "walkie-tokie/<host>/<session> <question>", call send_message with trigger=<that whole string>.
3. Otherwise call send_message with to=<recipient identifier> and message=<question>.
4. The call blocks until the author answers, rejects, closes review mode, or the timeout expires.
5. Use 60 second reviewer-side waits by default. When resumable replies are available, call send_message once, then keep calling wait_for_reply with the returned requestId until it returns answered, rejected, cancelled, or the user tells you to stop. Do not call send_message again for the same question after a timeout.

Use relay_status for debugging local relay reachability. Do not ask users to manually start walkie-tokied in the normal flow.`,
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
  "prepare_review_mode",
  {
    title: "Prepare Review Mode",
    description:
      "Author-side setup. Starts the local relay, creates review mode if needed, and returns both remote and same-machine share strings to show before waiting.",
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
      requestId: requestIdSchema.describe("Request id returned by wait_for_message"),
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
  const localRecipient = `${localHostPort(relay.localUrl)}/${sessionName}`;
  const localTriggerPrefix = `walkie-tokie/${localRecipient}`;
  if (!host) {
    return {
      status: created ? "created" : "ready",
      sessionName,
      recipient: null,
      triggerPrefix: null,
      remoteRecipient: null,
      remoteTriggerPrefix: null,
      localRecipient,
      localTriggerPrefix,
      relay,
      message:
        "Review mode is ready. For a same-machine agent, share: " +
        `${localTriggerPrefix} <question>. Walkie Tokie could not detect a Tailscale host/IP for remote agents. ` +
        "Set WALKIE_TOKIE_PUBLIC_HOST to your Tailscale hostname or IPv4 address, then call prepare_review_mode again.",
    };
  }

  const remoteRecipient = `${host}/${sessionName}`;
  const remoteTriggerPrefix = `walkie-tokie/${remoteRecipient}`;
  return {
    status: created ? "created" : "ready",
    sessionName,
    recipient: remoteRecipient,
    triggerPrefix: remoteTriggerPrefix,
    remoteRecipient,
    remoteTriggerPrefix,
    localRecipient,
    localTriggerPrefix,
    relay,
    message:
      "Walkie Tokie is ready. Share both strings before waiting:\n" +
      `Remote agent: ${remoteTriggerPrefix} <question>\n` +
      `Same-machine agent: ${localTriggerPrefix} <question>`,
  };
}

function localHostPort(localUrl: string): string {
  try {
    const url = new URL(localUrl);
    const port = url.port || "80";
    return `${url.hostname}:${port}`;
  } catch {
    return "127.0.0.1:8787";
  }
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
