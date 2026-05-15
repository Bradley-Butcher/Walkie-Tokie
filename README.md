# Walkie Tokie

Agent-to-agent questions for parked coding sessions.

Walkie Tokie lets one agent make its current context available to another
agent. The common case is PR review: the author parks their agent, a reviewer
agent asks about intent or implementation details, and the author comes back to
one transcript instead of acting as the human message bus.

PR review is only one use case. The shared session can also be a design thread,
an investigation, or any other useful agent context.

## Install

```sh
npm install -g walkie-tokie
walkie-tokie mcp install
```

Restart Codex after installing so it starts the MCP server.

## Quick Start

### Share A Session

In the agent session with the useful context, ask it to enter sharing mode:

```text
Prepare Walkie Tokie review mode for this work.
Use session name review-pr-123.
Tell me the share strings before waiting.
```

The agent should call `prepare_review_mode`, show both share strings, then call
`wait_for_message`.

Remote agents on another machine use the Tailscale form:

```text
walkie-tokie/alice-laptop/review-pr-123 <question>
```

Agents on the same machine use the local form:

```text
walkie-tokie/127.0.0.1:8787/review-pr-123 <question>
```

### Ask A Shared Session

Give the other agent one of the share strings and ask normally:

```text
walkie-tokie/alice-laptop/review-pr-123 Why does this validation live here?
```

When an MCP-enabled agent sees that shape, it should call `send_message` with
the full string as `trigger`.

Reviewer agents should use 60 second waits by default. When resumable replies
are available, reviewer agents should call `send_message` once, then keep
calling `wait_for_reply` with the returned request id until the request is
answered, rejected, cancelled, or the user asks them to stop.

Author agents should call `wait_for_message` again after every reply unless the
user tells them to stop or close review mode. Reviewer agents may have follow-up
questions.

## MCP Tools

The MCP server exposes the happy-path tools only:

- `prepare_review_mode`: starts the local relay, creates or refreshes a shared
  session, and returns remote and local share strings.
- `wait_for_message`: waits for the next message to that session.
- `reply_to_review_request`: sends the answer back to the asking agent.
- `send_message`: sends a question to a shared session and waits for the answer.
- `relay_status`: reports local relay reachability.

## Network Model

`wait_for_message` starts `walkie-tokied` when needed. The daemon binds to
`0.0.0.0` so the local MCP client can use `127.0.0.1` and remote agents can use
the same process over Tailscale.

In the default no-token mode, unauthenticated requests are accepted only from:

- localhost
- Tailscale IPv4 peers in `100.64.0.0/10`

LAN and public-interface callers are rejected. If you intentionally want to
serve outside that boundary, configure `WALKIE_TOKIE_TOKEN`.

Walkie Tokie prefers Tailscale DNS names such as `alice-laptop` in remote share
strings. If hostname discovery fails, it falls back to the Tailscale IPv4
address.

## CLI

```sh
walkie-tokie --help
walkie-tokie mcp install
walkie-tokie endpoints
walkie-tokie wait --help
walkie-tokie ask --help
```

## Development

```sh
npm ci
npm run check
```

The package builds to `dist/`; generated artifacts and dependencies are not
tracked in git.

Releases are published from GitHub Actions when a `v*` tag is pushed. The npm
package is public and ships compiled JavaScript only.
