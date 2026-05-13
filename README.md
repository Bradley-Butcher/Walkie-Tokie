# Walkie Tokie

Design spike for letting one reviewer's agent talk to an author's parked Codex
session during PR review.

The core idea is simple:

1. The author finishes a PR and switches their Codex session into review mode.
2. The author's visible Codex session calls a blocking wait tool, such as
   `wait_for_message(session_name="big-brain-bert")`.
3. A reviewer agent calls `send_message(to, message)`.
4. The relay matches those two blocking calls over Tailscale.
5. Every remote exchange is appended to the author's real Codex session, so the
   author can later resume the same thread and see what happened.

This repo is prototype-first now. It intentionally separates the local agent API
from the network protocol so the design can evolve without making MCP a
tailnet-wide transport.

## Proposed Components

- `walkie-tokied`: Author-side daemon. Receives authenticated review messages,
  validates policy, queues requests while the author agent is busy, matches
  requests to the author's blocking wait call, and streams the answer back.
- `walkie-tokie`: CLI. Starts review mode, lists leases, closes review mode,
  and prints audit logs.
- `walkie-tokie-mcp`: Local stdio MCP server. Exposes both reviewer tools
  (`send_message`) and author tools
  (`wait_for_message`, `reply_to_review_request`, `close_review_mode`).
  Each agent runs its own local MCP server; MCP is not the tailnet protocol.

## First Useful Scenario

Brad's agent calls `wait_for_message`:

```json
{
  "session_name": "big-brain-bert",
  "repo": "withcoral/coral",
  "pr": 1234,
  "allowedCallers": ["pawel"],
  "capabilities": ["inspect"]
}
```

Pawel's agent calls its local MCP tool:

```json
{
  "to": "brad-laptop/big-brain-bert",
  "message": "Why is validation below the gRPC boundary instead of in the handler?",
  "mode": "inspect",
  "timeoutSeconds": 900
}
```

Brad's Codex session is already blocked in `wait_for_message`. That call
returns Pawel's question as JSON. Brad's agent answers through
`reply_to_review_request`, and Pawel's original `send_message` call returns
with the answer.

## Design Docs

- [Architecture](docs/architecture.md)
- [Protocol](docs/protocol.md)
- [Security and Lifecycle](docs/security-and-lifecycle.md)
- [ADR 0001: Parked Live Session](docs/adr/0001-parked-live-session.md)

## Repository Status

The first implementation is a TypeScript local-only prototype:

1. author session calls `wait_for_message`
2. `wait_for_message` starts `walkie-tokied` and review mode if needed
3. reviewer calls `send_message(to, message)`
4. relay delivers the request to the waiting author call
5. author calls `reply_to_review_request`
6. reviewer call returns with the answer
7. JSONL audit log

The current code implements steps 1-6 with an in-memory relay, HTTP API, CLI,
and stdio MCP surface. Durable audit storage is next.

The daemon uses Fastify with bounded JSON bodies, shared Zod validation, and
long-request timeout settings suitable for blocking review calls. The CLI uses
Commander rather than hand-parsed flags.

## Install

```shell
npm install -g git+https://github.com/Bradley-Butcher/Walkie-Tokie.git
```

That installs three commands:

- `walkie-tokie`
- `walkie-tokied`
- `walkie-tokie-mcp`

For local development from a checkout:

```shell
git clone https://github.com/Bradley-Butcher/Walkie-Tokie.git
cd Walkie-Tokie
npm ci
npm run build
```

## MCP Setup

Everyone runs the same install command:

```shell
walkie-tokie mcp install
```

If your local username is not the identity colleagues should allowlist:

```shell
walkie-tokie mcp install --user pawel
```

This installs one role-neutral MCP server into Codex. One day's reviewer can be
the next day's author; the tools are the same.

When you want to receive messages, just call `wait_for_message`.
It starts the relay daemon automatically the first time it is needed, bound to
your Tailscale IP. The shareable identifier is:

```text
host/session-name
```

For example:

```text
brad-laptop/big-brain-bert
```

`walkie-tokied` still exists as a debug/manual command.

Tokens still exist as an optional escape hatch for non-Tailscale deployments or
if someone insists on a wildcard bind. They are not the happy path.

## Use

The author parks the Codex session with `wait_for_message`. If review mode is
not active yet, that tool creates it:

```json
{
  "session_name": "big-brain-bert",
  "repo": "withcoral/coral",
  "pr": 1234,
  "allowedCallers": ["pawel"],
  "capabilities": ["inspect"]
}
```

The reviewer asks through `send_message`:

```json
{
  "to": "brad-laptop/big-brain-bert",
  "message": "Why is validation below the gRPC boundary?",
  "mode": "inspect"
}
```

Important v0 caveat: `caller.user` is still supplied by the reviewer-side MCP
config. Use this with colleagues you trust on your tailnet until we replace that
with real Tailscale identity mapping.

## MCP

For local development:

```shell
npm run build
WALKIE_TOKIE_URL=http://127.0.0.1:8787 npm run dev:mcp
```

For a Codex MCP config, prefer the installer:

```shell
walkie-tokie mcp install
```

The exposed tools are:

- `list_review_endpoints`
- `relay_status`
- `start_review_mode`
- `close_review_mode`
- `wait_for_review_request`
- `wait_for_message`
- `reply_to_review_request`
- `send_message`
- `ask_review_peer`

The MCP smoke test launches that stdio server as a subprocess and runs the full
blocking ask/wait/reply exchange.

## Current Probe

`remote_control` is enabled in local Codex config for this machine.

After restarting Codex Desktop on 2026-05-13, the app-server process restarted
with the feature enabled. It still did not expose a reachable local listener or
the CLI proxy socket.

The useful discovery is that the native remote-control path did run: logs showed
Codex trying to create a remote-control enrollment against
`wss://chatgpt.com/backend-api/wham/remote/control/server`. That makes the
feature look cloud-mediated rather than a local Tailscale listener. Enrollment
failed with HTTP 404, and `remote_control_enrollments` stayed empty.

```shell
bash scripts/check-codex-remote-control.sh
```

Conclusion: app-visible external wakeup is not available to an external relay on
this machine yet. The design no longer depends on that. The visible Codex
session opts into review mode by running a blocking local tool and waiting for
the next review request.
