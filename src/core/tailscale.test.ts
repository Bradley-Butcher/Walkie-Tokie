import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import { describe, it } from "node:test";
import {
  detectTailscaleHost,
  detectTailscaleHostnameFromCli,
  detectTailscaleIpv4,
  detectTailscaleIpv4FromCli,
  detectTailscaleIpv4FromInterfaces,
  isAllowedUnauthenticatedPeerAddress,
  isLocalPeerAddress,
  isTailscaleIpv4,
} from "./tailscale.js";

describe("Tailscale address detection", () => {
  it("recognizes Tailscale IPv4 addresses", () => {
    assert.equal(isTailscaleIpv4("100.64.0.1"), true);
    assert.equal(isTailscaleIpv4("100.127.255.254"), true);
    assert.equal(isTailscaleIpv4("::ffff:100.78.16.74"), true);
    assert.equal(isTailscaleIpv4("100.128.0.1"), false);
    assert.equal(isTailscaleIpv4("192.168.1.10"), false);
    assert.equal(isTailscaleIpv4("localhost"), false);
  });

  it("allows unauthenticated peers only from localhost or Tailscale IPv4", () => {
    assert.equal(isLocalPeerAddress("127.0.0.1"), true);
    assert.equal(isLocalPeerAddress("::1"), true);
    assert.equal(isAllowedUnauthenticatedPeerAddress("127.0.0.1"), true);
    assert.equal(isAllowedUnauthenticatedPeerAddress("::ffff:127.0.0.1"), true);
    assert.equal(isAllowedUnauthenticatedPeerAddress("100.78.16.74"), true);
    assert.equal(isAllowedUnauthenticatedPeerAddress("192.168.1.20"), false);
    assert.equal(isAllowedUnauthenticatedPeerAddress("10.0.0.8"), false);
    assert.equal(isAllowedUnauthenticatedPeerAddress("8.8.8.8"), false);
  });

  it("uses the Tailscale CLI when available", () => {
    const address = detectTailscaleIpv4FromCli(() => ({
      status: 0,
      stdout: "100.78.16.74\n",
    }));

    assert.equal(address, "100.78.16.74");
  });

  it("prefers the Tailscale DNS hostname over the raw IPv4 address", () => {
    const host = detectTailscaleHost({
      runCommand: (command, args) => {
        if (args.join(" ") === "status --json") {
          return {
            status: 0,
            stdout: JSON.stringify({
              Self: {
                DNSName: "brad-laptop.example.ts.net.",
                HostName: "MacBook-Pro",
              },
            }),
          };
        }
        return {
          status: 0,
          stdout: "100.78.16.74\n",
        };
      },
    });

    assert.equal(host, "brad-laptop");
  });

  it("tries the macOS app-bundled Tailscale CLI when tailscale is not on PATH", () => {
    const commands: string[] = [];
    const host = detectTailscaleHostnameFromCli((command) => {
      commands.push(command);
      return {
        status: command.includes("Tailscale.app") ? 0 : 1,
        stdout: command.includes("Tailscale.app")
          ? JSON.stringify({ Self: { DNSName: "brad-laptop.example.ts.net." } })
          : "",
      };
    });

    assert.deepEqual(commands, [
      "tailscale",
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ]);
    assert.equal(host, "brad-laptop");
  });

  it("falls back to Tailscale IPv4 when hostname discovery is unavailable", () => {
    const host = detectTailscaleHost({
      runCommand: () => ({
        status: 1,
        stdout: "",
      }),
      interfaces: {
        utun8: [ipv4("100.78.16.74", false)],
      },
    });

    assert.equal(host, "100.78.16.74");
  });

  it("ignores non-Tailscale CLI output", () => {
    const address = detectTailscaleIpv4FromCli(() => ({
      status: 0,
      stdout: "192.168.1.20\n",
    }));

    assert.equal(address, undefined);
  });

  it("falls back to non-local Tailscale-range network interfaces", () => {
    const address = detectTailscaleIpv4({
      runCommand: () => ({
        status: 1,
        stdout: "",
      }),
      interfaces: {
        lo0: [ipv4("127.0.0.1", true)],
        en0: [ipv4("192.168.1.20", false)],
        utun8: [ipv4("100.78.16.74", false)],
      },
    });

    assert.equal(address, "100.78.16.74");
  });

  it("does not use internal Tailscale-range interfaces", () => {
    const address = detectTailscaleIpv4FromInterfaces({
      lo0: [ipv4("100.78.16.74", true)],
    });

    assert.equal(address, undefined);
  });
});

function ipv4(address: string, internal: boolean): NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.255",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/32`,
  };
}
