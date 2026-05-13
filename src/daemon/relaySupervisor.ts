import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

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

export async function ensureDaemonRunning(
  options: RelaySupervisorOptions = {},
): Promise<RelayStatus> {
  const port = options.port ?? defaultPort;
  const localUrl = options.localUrl ?? `http://127.0.0.1:${port}`;
  const fetchImpl = options.fetch ?? fetch;

  if (await isHealthy(localUrl, fetchImpl)) {
    return { running: true, localUrl };
  }

  const publicHost = (options.detectTailscaleIp ?? detectTailscaleIp)();
  if (!publicHost) {
    throw new Error(
      "walkie-tokied is not running and no Tailscale IPv4 address was found. " +
        "Install Tailscale, run `tailscale up`, or start walkie-tokied manually.",
    );
  }

  const child = startDaemon({
    host: publicHost,
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
    publicUrl: `http://${publicHost}:${port}`,
    pid: child.pid,
    started: true,
  };
}

export async function relayStatus(options: RelaySupervisorOptions = {}): Promise<RelayStatus> {
  const port = options.port ?? defaultPort;
  const localUrl = options.localUrl ?? `http://127.0.0.1:${port}`;
  const fetchImpl = options.fetch ?? fetch;
  const running = await isHealthy(localUrl, fetchImpl);
  const publicHost = (options.detectTailscaleIp ?? detectTailscaleIp)();
  return {
    running,
    localUrl,
    publicHost,
    publicUrl: publicHost ? `http://${publicHost}:${port}` : undefined,
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

function detectTailscaleIp(): string | undefined {
  const result = spawnSync("tailscale", ["ip", "-4"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function siblingBin(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}
