import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRelayHttpServer, serverUrl } from "../server/http.js";

const target = "brad/withcoral/coral#1234";

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
        WALKIE_TOKIE_USER: "pawel",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "walkie-tokie-mcp-test", version: "0.1.0" });

    try {
      await client.connect(transport);
      assert.match(client.getInstructions() ?? "", /Preferred reviewer flow/);
      assert.match(client.getInstructions() ?? "", /host\/session-name/);

      const tools = await client.listTools();
      assert.ok(tools.tools.some((tool) => tool.name === "ask_review_peer"));
      assert.ok(tools.tools.some((tool) => tool.name === "send_message"));
      assert.ok(tools.tools.some((tool) => tool.name === "wait_for_message"));
      assert.ok(tools.tools.some((tool) => tool.name === "wait_for_review_request"));

      await callJson(client, "start_review_mode", {
        target,
        repo: "withcoral/coral",
        pr: 1234,
        session: "big-brain-bert",
        allowedCallers: ["pawel"],
        capabilities: ["inspect"],
      });

      const wait = callJson(client, "wait_for_review_request", {
        endpoint: target,
        timeoutSeconds: 5,
      });
      const ask = callJson(client, "ask_review_peer", {
        target,
        question: "Why is validation below the gRPC boundary?",
        mode: "inspect",
        timeoutSeconds: 5,
      });

      const delivered = await wait;
      assert.equal(delivered.status, "request");
      assert.equal(delivered.request.question, "Why is validation below the gRPC boundary?");
      assert.equal(delivered.request.origin.user, "pawel");

      await callJson(client, "reply_to_review_request", {
        requestId: delivered.request.requestId,
        answer: "Because the transport boundary should stay thin.",
      });

      assert.deepEqual(await ask, {
        requestId: delivered.request.requestId,
        status: "answered",
        answer: "Because the transport boundary should stay thin.",
      });

      const address = app.server.address() as AddressInfo;
      const sessionWait = callJson(client, "wait_for_message", {
        session_name: "big-brain-bert",
        timeoutSeconds: 5,
      });
      const sessionAsk = callJson(client, "send_message", {
        host: `127.0.0.1:${address.port}`,
        session_name: "big-brain-bert",
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

      const autoWait = callJson(client, "wait_for_message", {
        session_name: "auto-start-bert",
        repo: "withcoral/coral",
        pr: 5678,
        allowedCallers: ["pawel"],
        capabilities: ["inspect"],
        timeoutSeconds: 5,
      });
      await sleep(50);
      const autoAsk = callJson(client, "send_message", {
        to: `127.0.0.1:${address.port}/auto-start-bert`,
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
