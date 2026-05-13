import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectTailscaleHost } from "../core/tailscale.js";

export interface RelaySupervisorOptions {
  localUrl?: string;
  port?: number;
  healthTimeoutMs?: number;
  pollIntervalMs?: number;
  fetch?: typeof fetch;
  spawnProcess?: SpawnProcess;
  detectTailscaleIp?: () => string | undefined;
  daemonPath?: string;
}

export interface RelayStatus {
  running: boolean;
  localUrl: string;
  publicHost?: string;
  publicUrl?: string;
  pid?: number;
  started?: boolean;
}

type SpawnProcess = (
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
) => Pick<ChildProcess, "pid" | "unref">;

const defaultPort = 8787;
const defaultBindHost = "0.0.0.0";

export async function ensureDaemonRunning(
  options: RelaySupervisorOptions = {},
): Promise<RelayStatus> {
  const port = options.port ?? defaultPort;
  const localUrl = options.localUrl ?? `http://127.0.0.1:${port}`;
  const fetchImpl = options.fetch ?? fetch;
  const publicHost = (options.detectTailscaleIp ?? detectTailscaleHost)();

  if (await isHealthy(localUrl, fetchImpl)) {
    return relayStatusResult({ running: true, localUrl, publicHost, port });
  }

  const child = startDaemon({
    host: defaultBindHost,
    port,
    daemonPath: options.daemonPath,
    spawnProcess: options.spawnProcess,
  });

  await waitForHealth(localUrl, fetchImpl, {
    timeoutMs: options.healthTimeoutMs ?? 5_000,
    pollIntervalMs: options.pollIntervalMs ?? 100,
  });

  return {
    running: true,
    localUrl,
    publicHost,
    publicUrl: publicHost ? `http://${publicHost}:${port}` : undefined,
    pid: child.pid,
    started: true,
  };
}

export async function relayStatus(options: RelaySupervisorOptions = {}): Promise<RelayStatus> {
  const port = options.port ?? defaultPort;
  const localUrl = options.localUrl ?? `http://127.0.0.1:${port}`;
  const fetchImpl = options.fetch ?? fetch;
  const running = await isHealthy(localUrl, fetchImpl);
  const publicHost = (options.detectTailscaleIp ?? detectTailscaleHost)();
  return relayStatusResult({ running, localUrl, publicHost, port });
}

function relayStatusResult(input: {
  running: boolean;
  localUrl: string;
  publicHost?: string;
  port: number;
}): RelayStatus {
  return {
    running: input.running,
    localUrl: input.localUrl,
    publicHost: input.publicHost,
    publicUrl: input.publicHost ? `http://${input.publicHost}:${input.port}` : undefined,
  };
}

function startDaemon(input: {
  host: string;
  port: number;
  daemonPath?: string;
  spawnProcess?: SpawnProcess;
}): ChildProcess {
  const child = (input.spawnProcess ?? spawn)(process.execPath, [
    input.daemonPath ?? siblingBin("../bin/walkie-tokied.js"),
  ], {
    detached: true,
    env: {
      ...process.env,
      WALKIE_TOKIE_HOST: input.host,
      WALKIE_TOKIE_PORT: String(input.port),
      WALKIE_TOKIE_LOG: process.env.WALKIE_TOKIE_LOG ?? "0",
    },
    stdio: "ignore",
  });
  child.unref();
  return child as ChildProcess;
}

async function isHealthy(localUrl: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${localUrl}/healthz`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(
  localUrl: string,
  fetchImpl: typeof fetch,
  options: { timeoutMs: number; pollIntervalMs: number },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy(localUrl, fetchImpl)) {
      return;
    }
    await sleep(options.pollIntervalMs);
  }
  throw new Error(`walkie-tokied did not become healthy at ${localUrl}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function siblingBin(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}
