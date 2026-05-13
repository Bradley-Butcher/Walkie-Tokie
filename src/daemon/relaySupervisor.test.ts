import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ensureDaemonRunning, relayStatus } from "./relaySupervisor.js";

describe("relay supervisor", () => {
  it("returns existing health and public URL without spawning the daemon", async () => {
    let spawnCount = 0;
    const status = await ensureDaemonRunning({
      detectTailscaleIp: () => "100.64.0.10",
      fetch: async () => new Response("ok", { status: 200 }),
      spawnProcess: () => {
        spawnCount += 1;
        return { pid: 123, unref: () => undefined };
      },
    });

    assert.equal(spawnCount, 0);
    assert.deepEqual(status, {
      running: true,
      localUrl: "http://127.0.0.1:8787",
      publicHost: "100.64.0.10",
      publicUrl: "http://100.64.0.10:8787",
    });
  });

  it("starts the daemon on a wildcard bind and reports the detected Tailscale URL", async () => {
    let calls = 0;
    const spawned: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];

    const status = await ensureDaemonRunning({
      detectTailscaleIp: () => "100.64.0.10",
      pollIntervalMs: 1,
      healthTimeoutMs: 100,
      fetch: async () => {
        calls += 1;
        return new Response("ok", { status: calls >= 2 ? 200 : 503 });
      },
      spawnProcess: (command, args, options) => {
        spawned.push({ command, args, env: options?.env });
        return { pid: 456, unref: () => undefined };
      },
    });

    assert.equal(spawned.length, 1);
    assert.equal(spawned[0]?.env?.WALKIE_TOKIE_HOST, "0.0.0.0");
    assert.equal(spawned[0]?.env?.WALKIE_TOKIE_PORT, "8787");
    assert.equal(status.running, true);
    assert.equal(status.publicUrl, "http://100.64.0.10:8787");
    assert.equal(status.pid, 456);
    assert.equal(status.started, true);
  });

  it("starts even when no Tailscale address can be detected locally", async () => {
    let calls = 0;
    const spawned: Array<{ env?: NodeJS.ProcessEnv }> = [];

    const status = await ensureDaemonRunning({
      detectTailscaleIp: () => undefined,
      pollIntervalMs: 1,
      healthTimeoutMs: 100,
      fetch: async () => {
        calls += 1;
        return new Response("ok", { status: calls >= 2 ? 200 : 503 });
      },
      spawnProcess: (_command, _args, options) => {
        spawned.push({ env: options?.env });
        return { pid: 789, unref: () => undefined };
      },
    });

    assert.equal(spawned[0]?.env?.WALKIE_TOKIE_HOST, "0.0.0.0");
    assert.equal(status.running, true);
    assert.equal(status.publicHost, undefined);
    assert.equal(status.publicUrl, undefined);
    assert.equal(status.started, true);
  });

  it("reports status without starting the daemon", async () => {
    const status = await relayStatus({
      detectTailscaleIp: () => "100.64.0.10",
      fetch: async () => {
        throw new Error("not running");
      },
    });

    assert.deepEqual(status, {
      running: false,
      localUrl: "http://127.0.0.1:8787",
      publicHost: "100.64.0.10",
      publicUrl: "http://100.64.0.10:8787",
    });
  });
});
