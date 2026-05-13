import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import { describe, it } from "node:test";
import {
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
