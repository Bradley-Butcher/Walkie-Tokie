import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRelayHttpServer, serverUrl } from "../server/http.js";

describe("walkie-tokie-mcp", () => {
  it("exposes the blocking review exchange over stdio MCP", async () => {
    const { app } = createRelayHttpServer();
    await app.listen({ host: "127.0.0.1", port: 0 });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/bin/walkie-tokie-mcp.js"],
      cwd: process.cwd(),
      env: {
        ...getDefaultEnvironment(),
        WALKIE_TOKIE_URL: serverUrl(app.server.address() as AddressInfo),
        WALKIE_TOKIE_PUBLIC_HOST: "alice-laptop",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "walkie-tokie-mcp-test", version: "0.1.0" });

    try {
      await client.connect(transport);
      assert.match(client.getInstructions() ?? "", /Preferred reviewer flow/);
      assert.match(client.getInstructions() ?? "", /prepare_review_mode/);
      assert.match(client.getInstructions() ?? "", /remoteTriggerPrefix/);
      assert.match(client.getInstructions() ?? "", /localTriggerPrefix/);
      assert.match(client.getInstructions() ?? "", /Do not share only triggerPrefix/);
      assert.match(client.getInstructions() ?? "", /Immediately call wait_for_message again after every reply or timeout/);
      assert.match(client.getInstructions() ?? "", /follow-up questions/);
      assert.match(client.getInstructions() ?? "", /host\/session-name/);

      const tools = await client.listTools();
      assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort(),
        [
          "prepare_review_mode",
          "relay_status",
          "reply_to_review_request",
          "send_message",
          "wait_for_message",
        ],
      );
      assertToolTimeoutDefault(tools.tools, "wait_for_message", 43_200, 86_400);
      assertToolTimeoutDefault(tools.tools, "send_message", 900, 3_600);

      const preparedMain = await callJson(client, "prepare_review_mode", {
        session_name: "review-pr-123",
        repo: "example/repo",
        pr: 1234,
        capabilities: ["inspect"],
      });
      assert.equal(preparedMain.remoteTriggerPrefix, "walkie-tokie/alice-laptop/review-pr-123");
      assert.match(String(preparedMain.localTriggerPrefix), /^walkie-tokie\/127\.0\.0\.1:\d+\/review-pr-123$/);

      const address = app.server.address() as AddressInfo;
      const sessionWait = callJson(client, "wait_for_message", {
        session_name: "review-pr-123",
        timeoutSeconds: 5,
      });
      const sessionAsk = callJson(client, "send_message", {
        host: `127.0.0.1:${address.port}`,
        session_name: "review-pr-123",
        message: "Can I send by host and session name?",
        mode: "inspect",
        timeoutSeconds: 5,
      });

      const sessionDelivered = await sessionWait;
      assert.equal(sessionDelivered.status, "request");
      assert.equal(sessionDelivered.request.question, "Can I send by host and session name?");

      await callJson(client, "reply_to_review_request", {
        requestId: sessionDelivered.request.requestId,
        answer: "Yes, the MCP tool routes by host and session.",
      });

      assert.deepEqual(await sessionAsk, {
        requestId: sessionDelivered.request.requestId,
        status: "answered",
        answer: "Yes, the MCP tool routes by host and session.",
      });

      const triggerWait = callJson(client, "wait_for_message", {
        session_name: "review-pr-123",
        timeoutSeconds: 5,
      });
      const triggerAsk = callJson(client, "send_message", {
        trigger: `walkie-tokie/127.0.0.1:${address.port}/review-pr-123 Does the trigger work?`,
        timeoutSeconds: 5,
      });

      const triggerDelivered = await triggerWait;
      assert.equal(triggerDelivered.status, "request");
      assert.equal(triggerDelivered.request.question, "Does the trigger work?");

      await callJson(client, "reply_to_review_request", {
        requestId: triggerDelivered.request.requestId,
        answer: "Yes, the copy-paste trigger routes to send_message.",
      });

      assert.deepEqual(await triggerAsk, {
        requestId: triggerDelivered.request.requestId,
        status: "answered",
        answer: "Yes, the copy-paste trigger routes to send_message.",
      });

      const prepared = await callJson(client, "prepare_review_mode", {
        session_name: "prepared-review",
        capabilities: ["inspect", "explain"],
      });
      assert.equal(prepared.status, "created");
      assert.equal(prepared.recipient, "alice-laptop/prepared-review");
      assert.equal(prepared.triggerPrefix, "walkie-tokie/alice-laptop/prepared-review");
      assert.equal(prepared.remoteRecipient, "alice-laptop/prepared-review");
      assert.equal(prepared.remoteTriggerPrefix, "walkie-tokie/alice-laptop/prepared-review");
      assert.match(String(prepared.localRecipient), /^127\.0\.0\.1:\d+\/prepared-review$/);
      assert.match(String(prepared.localTriggerPrefix), /^walkie-tokie\/127\.0\.0\.1:\d+\/prepared-review$/);
      assert.match(prepared.message, /Remote agent:/);
      assert.match(prepared.message, /Same-machine agent:/);
      assert.match(prepared.message, /walkie-tokie\/alice-laptop\/prepared-review <question>/);
      assert.match(prepared.message, /walkie-tokie\/127\.0\.0\.1:\d+\/prepared-review <question>/);

      const autoWait = callJson(client, "wait_for_message", {
        session_name: "auto-start-review",
        capabilities: ["inspect"],
        timeoutSeconds: 5,
      });
      await sleep(50);
      const autoAsk = callJson(client, "send_message", {
        to: `127.0.0.1:${address.port}/auto-start-review`,
        message: "Did wait_for_message create review mode?",
        mode: "inspect",
        timeoutSeconds: 5,
      });

      const autoDelivered = await autoWait;
      assert.equal(autoDelivered.status, "request");
      assert.equal(autoDelivered.request.question, "Did wait_for_message create review mode?");

      await callJson(client, "reply_to_review_request", {
        requestId: autoDelivered.request.requestId,
        answer: "Yes, review mode was created automatically.",
      });

      assert.deepEqual(await autoAsk, {
        requestId: autoDelivered.request.requestId,
        status: "answered",
        answer: "Yes, review mode was created automatically.",
      });
    } finally {
      await client.close();
      await transport.close();
      await app.close();
    }
  });
});

async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, any>> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  const first = content[0];
  assert.equal(first?.type, "text");
  const text = first.text;
  if (typeof text !== "string") {
    throw new Error(`Tool ${name} did not return text content`);
  }
  return JSON.parse(text) as Record<string, any>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertToolTimeoutDefault(
  tools: Array<{ name: string; inputSchema?: unknown }>,
  name: string,
  fallback: number,
  max: number,
): void {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `expected ${name} tool`);
  const schema = JSON.stringify(tool.inputSchema);
  assert.match(schema, /"timeoutSeconds"/);
  assert.match(schema, new RegExp(`"default":${fallback}`));
  assert.match(schema, new RegExp(`"maximum":${max}`));
}
