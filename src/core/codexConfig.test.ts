import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setMcpServerToolTimeout } from "./codexConfig.js";

describe("setMcpServerToolTimeout", () => {
  it("adds tool_timeout_sec to the server root table before env subtables", () => {
    const input = [
      "[mcp_servers.walkie-tokie]",
      'command = "node"',
      'args = [ "walkie-tokie-mcp" ]',
      "",
      "[mcp_servers.walkie-tokie.env]",
      'WALKIE_TOKIE_URL = "http://127.0.0.1:8787"',
      "",
    ].join("\n");

    assert.equal(
      setMcpServerToolTimeout(input, "walkie-tokie", 86_400),
      [
        "[mcp_servers.walkie-tokie]",
        'command = "node"',
        'args = [ "walkie-tokie-mcp" ]',
        "",
        "tool_timeout_sec = 86400.0",
        "[mcp_servers.walkie-tokie.env]",
        'WALKIE_TOKIE_URL = "http://127.0.0.1:8787"',
        "",
      ].join("\n"),
    );
  });

  it("updates an existing timeout", () => {
    const input = [
      "[mcp_servers.walkie-tokie]",
      'command = "node"',
      "tool_timeout_sec = 120.0",
      "",
    ].join("\n");

    assert.equal(
      setMcpServerToolTimeout(input, "walkie-tokie", 86_400),
      [
        "[mcp_servers.walkie-tokie]",
        'command = "node"',
        "tool_timeout_sec = 86400.0",
        "",
      ].join("\n"),
    );
  });

  it("throws if the server table is missing", () => {
    assert.throws(
      () => setMcpServerToolTimeout("[mcp_servers.other]\n", "walkie-tokie", 86_400),
      /Could not find/,
    );
  });
});
