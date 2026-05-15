#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import { capabilitySchema } from "../core/schemas.js";
import { detectTailscaleIpv4 } from "../core/tailscale.js";
import { RelayHttpClient } from "../client/relayHttpClient.js";

const client = new RelayHttpClient();
const program = new Command();

program
  .name("walkie-tokie")
  .description("CLI for Walkie Tokie agent review messages")
  .version("0.1.6");

const mcp = program.command("mcp").description("Manage the Codex MCP integration");

mcp
  .command("install")
  .description("Install the role-neutral Walkie Tokie MCP server into Codex")
  .option("--mcp-name <name>", "Codex MCP server name", "walkie-tokie")
  .option("--relay-url <url>", "Optional local relay URL for author-side tools", "http://127.0.0.1:8787")
  .option("--token <token>", "Optional bearer token for non-Tailscale deployments")
  .option("--skip-codex", "Only print commands; do not run codex mcp add")
  .action((options) => {
    if (!options.skipCodex) {
      configureCodexMcp({
        name: options.mcpName,
        relayUrl: options.relayUrl,
        token: options.token,
      });
    }

    printSetupSummary({
      title: "Walkie Tokie MCP installed",
      lines: [
        `Local relay URL: ${options.relayUrl}`,
        "Reviewer use: send_message(to, message)",
        "Author use: call wait_for_message; it starts walkie-tokied when needed",
      ],
    });
  });

const setup = program
  .command("setup")
  .description("Compatibility helpers. Prefer `walkie-tokie mcp install`.");

setup
  .command("author")
  .description("Print author relay startup instructions and install MCP")
  .option("--host <ip>", "Tailscale IPv4 address to bind the daemon to")
  .option("--port <number>", "Relay port", parsePositiveInt, 8787)
  .option("--mcp-name <name>", "Codex MCP server name", "walkie-tokie")
  .option("--token <token>", "Optional bearer token for non-Tailscale deployments")
  .option("--skip-codex", "Only print commands; do not run codex mcp add")
  .action((options) => {
    const host = options.host ?? detectTailscaleIpv4();
    if (!host) {
      throw new Error(
        "Could not find a Tailscale IPv4 address. Install Tailscale, run `tailscale up`, " +
          "connect Tailscale, install the Tailscale CLI, or pass --host <tailscale-ip>.",
      );
    }

    const localRelayUrl = `http://127.0.0.1:${options.port}`;
    const shareRelayUrl = `http://${host}:${options.port}`;
    if (!options.skipCodex) {
      configureCodexMcp({
        name: options.mcpName,
        relayUrl: localRelayUrl,
        token: options.token,
      });
    }

    printSetupSummary({
      title: "Author setup complete",
      lines: [
        `Start relay: ${formatEnvCommand(
          {
            WALKIE_TOKIE_PORT: String(options.port),
            ...(options.token ? { WALKIE_TOKIE_TOKEN: options.token } : {}),
          },
          "walkie-tokied",
        )}`,
        `Give reviewers this URL: ${shareRelayUrl}`,
        "The daemon listens on all interfaces by default but rejects unauthenticated non-local, non-Tailscale peers.",
        options.token ? "Give reviewers the token too." : "No token needed for normal Tailscale use.",
      ],
    });
  });

setup
  .command("reviewer")
  .description("Compatibility alias for `walkie-tokie mcp install`")
  .option("--mcp-name <name>", "Codex MCP server name", "walkie-tokie")
  .option("--token <token>", "Optional bearer token if the author configured one")
  .option("--skip-codex", "Only print commands; do not run codex mcp add")
  .action((options) => {
    if (!options.skipCodex) {
      configureCodexMcp({
        name: options.mcpName,
        token: options.token,
        relayUrl: "http://127.0.0.1:8787",
      });
    }

    printSetupSummary({
      title: "Walkie Tokie MCP installed",
      lines: [
        "Your agent can now call send_message(to, message).",
      ],
    });
  });

const reviewMode = program.command("review-mode").description("Manage review mode endpoints");

reviewMode
  .command("start")
  .description("Create or replace a review endpoint")
  .requiredOption("--target <target>", "Endpoint id, such as team/example/repo#1234")
  .requiredOption("--repo <repo>", "Repository in owner/name form")
  .requiredOption("--pr <number>", "Pull request number", parsePositiveInt)
  .requiredOption("--session <id>", "Human-friendly Codex session id")
  .requiredOption("--capability <mode>", "Allowed capability", collectCapability, [])
  .option("--max-pending <number>", "Maximum queued requests", parsePositiveInt)
  .action(async (options) => {
    await post("/v1/review-mode/start", {
      target: options.target,
      repo: options.repo,
      pr: options.pr,
      session: options.session,
      capabilities: options.capability,
      maxPending: options.maxPending,
    });
  });

reviewMode
  .command("close")
  .description("Close a review endpoint and cancel queued requests")
  .requiredOption("--target <target>", "Endpoint id, such as team/example/repo#1234")
  .action(async (options) => {
    await post("/v1/review-mode/close", {
      target: options.target,
    });
  });

program
  .command("endpoints")
  .description("List review endpoints")
  .action(async () => {
    printJson(await client.get("/v1/review-endpoints"));
  });

program
  .command("wait")
  .description("Author-side blocking wait for the next review request")
  .requiredOption("--endpoint <target>", "Endpoint id to wait on")
  .requiredOption("--timeout <duration>", "Timeout, such as 30s, 15m, or 12h", parseDurationSeconds)
  .action(async (options) => {
    await post("/v1/author/wait", {
      endpoint: options.endpoint,
      timeoutSeconds: options.timeout,
    });
  });

program
  .command("ask")
  .description("Reviewer-side blocking ask")
  .requiredOption("--target <target>", "Endpoint id to ask")
  .requiredOption("--question <text>", "Question for the author agent")
  .requiredOption("--mode <capability>", "Requested capability", parseCapability)
  .requiredOption("--timeout <duration>", "Timeout, such as 30s or 15m", parseDurationSeconds)
  .option("--agent <name>", "Reviewer agent name")
  .option("--machine <name>", "Reviewer machine name")
  .action(async (options) => {
    await post("/v1/review-requests:wait", {
      target: options.target,
      question: options.question,
      mode: options.mode,
      timeoutSeconds: options.timeout,
      caller: options.agent || options.machine
        ? {
            agent: options.agent,
            machine: options.machine,
          }
        : undefined,
    });
  });

program
  .command("reply")
  .description("Author-side reply to a delivered review request")
  .requiredOption("--request <id>", "Request id returned by wait")
  .requiredOption("--answer <text>", "Answer to return to the reviewer")
  .action(async (options) => {
    await post(`/v1/review-requests/${encodeURIComponent(options.request)}/reply`, {
      answer: options.answer,
    });
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function post(path: string, body: Record<string, unknown>) {
  printJson(await client.post(path, body));
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function collectCapability(value: string, previous: string[]): string[] {
  previous.push(parseCapability(value));
  return previous;
}

function parseCapability(input: string): string {
  const parsed = capabilitySchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidArgumentError(`Invalid capability: ${input}`);
  }
  return parsed.data;
}

function parsePositiveInt(input: string): number {
  const value = Number.parseInt(input, 10);
  if (!Number.isInteger(value) || value < 1 || String(value) !== input) {
    throw new InvalidArgumentError(`Expected a positive integer, got ${input}`);
  }
  return value;
}

function parseDurationSeconds(input: string): number {
  const match = input.match(/^(\d+)(s|m|h)?$/);
  if (!match) {
    throw new InvalidArgumentError(`Invalid duration: ${input}`);
  }

  const value = Number.parseInt(match[1] ?? "0", 10);
  const unit = match[2] ?? "s";
  if (unit === "h") return value * 3600;
  if (unit === "m") return value * 60;
  return value;
}

function configureCodexMcp(input: {
  name: string;
  relayUrl?: string;
  token?: string;
}): void {
  runCodex(["mcp", "remove", input.name], { allowFailure: true });

  const args = [
    "mcp",
    "add",
    input.name,
  ];
  if (input.relayUrl) {
    args.push("--env", `WALKIE_TOKIE_URL=${input.relayUrl}`);
  }
  if (input.token) {
    args.push("--env", `WALKIE_TOKIE_TOKEN=${input.token}`);
  }
  args.push("--", process.execPath, siblingBin("walkie-tokie-mcp.js"));

  runCodex(args);
}

function runCodex(args: string[], options: { allowFailure?: boolean } = {}): void {
  const result = spawnSync("codex", args, {
    encoding: "utf8",
    stdio: options.allowFailure ? "pipe" : "inherit",
  });
  if (result.error) {
    if (options.allowFailure) {
      return;
    }
    throw result.error;
  }
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`codex ${args.join(" ")} failed`);
  }
}

function siblingBin(filename: string): string {
  return fileURLToPath(new URL(`./${filename}`, import.meta.url));
}

function printSetupSummary(input: { title: string; lines: string[] }): void {
  process.stdout.write(`${input.title}\n`);
  for (const line of input.lines) {
    process.stdout.write(`- ${line}\n`);
  }
}

function formatEnvCommand(env: Record<string, string>, command: string): string {
  const assignments = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`);
  return [...assignments, command].join(" ");
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
