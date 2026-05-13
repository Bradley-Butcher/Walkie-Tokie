import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ensureRelaydRunning, relayStatus } from "./relaySupervisor.js";

describe("relay supervisor", () => {
  it("returns existing health without spawning relayd", async () => {
    let spawnCount = 0;
    const status = await ensureRelaydRunning({
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
    });
  });

  it("starts relayd on the detected Tailscale IP when health is missing", async () => {
    let calls = 0;
    const spawned: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];

    const status = await ensureRelaydRunning({
      detectTailscaleIp: () => "100.80.1.2",
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
    assert.equal(spawned[0]?.env?.WALKIE_TOKIE_HOST, "100.80.1.2");
    assert.equal(spawned[0]?.env?.WALKIE_TOKIE_PORT, "8787");
    assert.equal(spawned[0]?.env?.REVIEW_RELAY_HOST, "100.80.1.2");
    assert.equal(spawned[0]?.env?.REVIEW_RELAY_PORT, "8787");
    assert.equal(status.running, true);
    assert.equal(status.publicUrl, "http://100.80.1.2:8787");
    assert.equal(status.pid, 456);
    assert.equal(status.started, true);
  });

  it("reports status without starting relayd", async () => {
    const status = await relayStatus({
      detectTailscaleIp: () => "100.80.1.2",
      fetch: async () => {
        throw new Error("not running");
      },
    });

    assert.deepEqual(status, {
      running: false,
      localUrl: "http://127.0.0.1:8787",
      publicHost: "100.80.1.2",
      publicUrl: "http://100.80.1.2:8787",
    });
  });
});
