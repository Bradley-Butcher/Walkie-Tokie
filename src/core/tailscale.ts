import { spawnSync } from "node:child_process";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

type CommandRunner = (
  command: string,
  args: string[],
  options: Parameters<typeof spawnSync>[2],
) => Pick<ReturnType<typeof spawnSync>, "status" | "stdout">;

const tailscaleCliCandidates = [
  "tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

export function detectTailscaleHost(options: {
  runCommand?: CommandRunner;
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
} = {}): string | undefined {
  const runCommand = options.runCommand ?? spawnSync;
  return (
    detectTailscaleHostnameFromCli(runCommand) ??
    detectTailscaleIpv4({
      runCommand,
      interfaces: options.interfaces,
    })
  );
}

export function detectTailscaleIpv4(options: {
  runCommand?: CommandRunner;
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
} = {}): string | undefined {
  return (
    detectTailscaleIpv4FromCli(options.runCommand ?? spawnSync) ??
    detectTailscaleIpv4FromInterfaces(options.interfaces ?? networkInterfaces())
  );
}

export function detectTailscaleHostnameFromCli(
  runCommand: CommandRunner,
  commands = tailscaleCliCandidates,
): string | undefined {
  for (const command of commands) {
    const result = runCommand(command, ["status", "--json"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.status !== 0 || typeof result.stdout !== "string") {
      continue;
    }
    const hostname = parseTailscaleHostname(result.stdout);
    if (hostname) {
      return hostname;
    }
  }
  return undefined;
}

export function detectTailscaleIpv4FromCli(runCommand: CommandRunner): string | undefined {
  const result = runCommand("tailscale", ["ip", "-4"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return undefined;
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(isTailscaleIpv4);
}

export function detectTailscaleIpv4FromInterfaces(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): string | undefined {
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal && isTailscaleIpv4(address.address)) {
        return address.address;
      }
    }
  }
  return undefined;
}

export function isTailscaleIpv4(host: string): boolean {
  const address = normalizeIpAddress(host);
  if (!address) {
    return false;
  }
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

export function isLocalPeerAddress(host: string): boolean {
  const address = normalizeIpAddress(host);
  return address === "127.0.0.1" || address === "::1";
}

export function isAllowedUnauthenticatedPeerAddress(host: string): boolean {
  return isLocalPeerAddress(host) || isTailscaleIpv4(host);
}

function parseTailscaleHostname(statusJson: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(statusJson);
  } catch {
    return undefined;
  }

  const self = typeof parsed === "object" && parsed !== null
    ? (parsed as { Self?: unknown }).Self
    : undefined;
  if (typeof self !== "object" || self === null) {
    return undefined;
  }

  const dnsName = (self as { DNSName?: unknown }).DNSName;
  if (typeof dnsName === "string") {
    const firstLabel = dnsName.replace(/\.$/, "").split(".")[0];
    if (isShareableHost(firstLabel)) {
      return firstLabel;
    }
  }

  const hostName = (self as { HostName?: unknown }).HostName;
  if (typeof hostName === "string" && isShareableHost(hostName)) {
    return hostName;
  }

  return undefined;
}

function isShareableHost(host: string | undefined): host is string {
  return typeof host === "string" && /^[a-zA-Z0-9_.-]+$/.test(host) && host.length > 0;
}

function normalizeIpAddress(host: string): string | undefined {
  if (host.startsWith("::ffff:")) {
    return host.slice("::ffff:".length);
  }
  return host;
}
