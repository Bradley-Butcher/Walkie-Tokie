import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRelayHttpServer, isTailscaleIpv4 } from "./http.js";

describe("relay HTTP server", () => {
  it("recognizes Tailscale IPv4 addresses", () => {
    assert.equal(isTailscaleIpv4("100.64.0.1"), true);
    assert.equal(isTailscaleIpv4("100.127.255.254"), true);
    assert.equal(isTailscaleIpv4("100.128.0.1"), false);
    assert.equal(isTailscaleIpv4("192.168.1.10"), false);
    assert.equal(isTailscaleIpv4("localhost"), false);
  });

  it("requires bearer auth when a relay token is configured", async () => {
    const { app } = createRelayHttpServer({ token: "test-token" });
    try {
      const rejected = await app.inject({
        method: "GET",
        url: "/v1/review-endpoints",
      });
      assert.equal(rejected.statusCode, 401);
      assert.equal(rejected.json().error.code, "not_allowed");

      const accepted = await app.inject({
        method: "GET",
        url: "/v1/review-endpoints",
        headers: {
          authorization: "Bearer test-token",
        },
      });
      assert.equal(accepted.statusCode, 200);
      assert.deepEqual(accepted.json(), { endpoints: [] });
    } finally {
      await app.close();
    }
  });

  it("allows unauthenticated localhost and Tailscale peers", async () => {
    const { app } = createRelayHttpServer();
    try {
      const local = await app.inject({
        method: "GET",
        url: "/v1/review-endpoints",
        remoteAddress: "127.0.0.1",
      });
      assert.equal(local.statusCode, 200);

      const tailnet = await app.inject({
        method: "GET",
        url: "/v1/review-endpoints",
        remoteAddress: "100.78.16.74",
      });
      assert.equal(tailnet.statusCode, 200);
    } finally {
      await app.close();
    }
  });

  it("rejects unauthenticated LAN peers even when the daemon is bound broadly", async () => {
    const { app } = createRelayHttpServer();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/review-endpoints",
        remoteAddress: "192.168.1.20",
      });

      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error.code, "not_allowed");
    } finally {
      await app.close();
    }
  });

  it("rejects invalid endpoint ids before mutating relay state", async () => {
    const { app } = createRelayHttpServer();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/review-mode/start",
        payload: {
          target: "example-repo#1234",
          repo: "example/repo",
          pr: 1234,
          session: "review-pr-123",
          capabilities: ["inspect"],
        },
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, "invalid_request");

      const endpoints = await app.inject({
        method: "GET",
        url: "/v1/review-endpoints",
      });
      assert.deepEqual(endpoints.json(), { endpoints: [] });
    } finally {
      await app.close();
    }
  });

  it("runs the blocking wait/ask/reply exchange through Fastify routes", async () => {
    const { app } = createRelayHttpServer();
    try {
      const target = "team/example/repo#1234";
      const start = await app.inject({
        method: "POST",
        url: "/v1/review-mode/start",
        payload: {
          target,
          repo: "example/repo",
          pr: 1234,
          session: "review-pr-123",
          capabilities: ["inspect"],
        },
      });
      assert.equal(start.statusCode, 200);

      const wait = app.inject({
        method: "POST",
        url: "/v1/author/wait",
        payload: {
          endpoint: target,
          timeoutSeconds: 5,
        },
      });

      const ask = app.inject({
        method: "POST",
        url: "/v1/review-requests:wait",
        payload: {
          target,
          question: "What invariant makes this safe?",
          mode: "inspect",
          timeoutSeconds: 5,
        },
      });

      const delivered = await wait;
      assert.equal(delivered.statusCode, 200);
      const deliveredBody = delivered.json();
      assert.equal(deliveredBody.status, "request");
      assert.equal(deliveredBody.request.question, "What invariant makes this safe?");

      const reply = await app.inject({
        method: "POST",
        url: `/v1/review-requests/${deliveredBody.request.requestId}/reply`,
        payload: {
          answer: "The invariant is checked below the transport boundary.",
        },
      });
      assert.equal(reply.statusCode, 200);

      assert.deepEqual((await ask).json(), {
        requestId: deliveredBody.request.requestId,
        status: "answered",
        answer: "The invariant is checked below the transport boundary.",
      });
    } finally {
      await app.close();
    }
  });

  it("routes messages by session name", async () => {
    const { app } = createRelayHttpServer();
    try {
      const target = "team/example/repo#1234";
      await app.inject({
        method: "POST",
        url: "/v1/review-mode/start",
        payload: {
          target,
          repo: "example/repo",
          pr: 1234,
          session: "review-pr-123",
          capabilities: ["inspect"],
        },
      });

      const wait = app.inject({
        method: "POST",
        url: "/v1/sessions/review-pr-123/wait",
        payload: {
          timeoutSeconds: 5,
        },
      });

      const ask = app.inject({
        method: "POST",
        url: "/v1/sessions/review-pr-123/messages/wait",
        payload: {
          message: "Can I send by session name?",
          mode: "inspect",
          timeoutSeconds: 5,
        },
      });

      const delivered = await wait;
      assert.equal(delivered.statusCode, 200);
      const deliveredBody = delivered.json();
      assert.equal(deliveredBody.request.question, "Can I send by session name?");

      await app.inject({
        method: "POST",
        url: `/v1/review-requests/${deliveredBody.request.requestId}/reply`,
        payload: {
          answer: "Yes.",
        },
      });

      assert.deepEqual((await ask).json(), {
        requestId: deliveredBody.request.requestId,
        status: "answered",
        answer: "Yes.",
      });
    } finally {
      await app.close();
    }
  });
});
