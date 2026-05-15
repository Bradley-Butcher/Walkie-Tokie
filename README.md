# Walkie Tokie

Agent-to-agent review questions for parked coding sessions.

Walkie Tokie lets a reviewer agent ask questions of the author's parked agent
while a PR is waiting for review. The goal is to keep review moving without
forcing the author to stay online as the human relay.

## Workflow

1. Someone has useful context in an agent session: a PR, a design discussion,
   an incident investigation, or a half-finished debugging thread.
2. They park that agent in sharing mode. The agent should first call
   `prepare_review_mode`, then share the returned recipient strings before it
   starts waiting. Agents on another machine use the remote form:

   ```text
   walkie-tokie/alice-laptop/review-pr-123
   ```

   Agents on the same machine use the local form:

   ```text
   walkie-tokie/127.0.0.1:8787/review-pr-123
   ```

3. The parked agent then calls `wait_for_message` and blocks for reviewer
   questions.
4. Someone else brings their own agent to the work.
5. If they have a question about intent, motivation, tradeoffs, or expected
   behavior, they paste the recipient string and ask:

   ```text
   walkie-tokie/alice-laptop/review-pr-123 Why does this validation live here?
   ```

6. Their agent sends the question to the parked agent and waits
   for an answer.
7. The parked agent answers from its original context. It can explain
   the work, point at evidence, or say that a change is probably needed.
8. Later, the owner comes back to one conversation: their agent has handled the
   questions and can summarize any agreed follow-up changes.
9. The owner greenlights the changes or takes back control.

The owner explicitly enters sharing mode. Walkie Tokie is not a general inbox or
background task runner. PR review is the first workflow, not the only one.

## Network model

`wait_for_message` starts the local daemon when needed. The daemon binds to
`0.0.0.0` so the local MCP client can reach `127.0.0.1` and reviewer agents can
reach the same process over Tailscale.

In the default no-token mode, the HTTP server accepts unauthenticated requests
only from:

- localhost
- Tailscale IPv4 peers in `100.64.0.0/10`

LAN and public-interface callers are rejected. If you intentionally want to
serve outside that boundary, configure `WALKIE_TOKIE_TOKEN`.

The first implementation provides:

- a TypeScript relay core for blocking ask/wait/reply flows
- a Fastify HTTP API with shared Zod validation
- a stdio MCP server with `prepare_review_mode`, `send_message`, and
  `wait_for_message`
- a CLI and local daemon for running the relay

## Install

```shell
npm install -g walkie-tokie
walkie-tokie mcp install
```

Releases are published from GitHub Actions when a `v*` tag is pushed. The npm
package is public and ships compiled JavaScript only.

## Ask

Authors can share a copy-paste trigger in a PR:

```text
walkie-tokie/alice-laptop/review-pr-123 <question>
```

When an MCP-enabled agent sees that shape, it should call `send_message` with
the full string as `trigger`.

Reviewer agents should use 60 second waits by default. Once the protocol grows
resumable replies, reviewer agents should call `send_message` once, then keep
calling `wait_for_reply` with the returned request id until the request is
answered, rejected, cancelled, or the user asks them to stop.

## Development

```shell
npm ci
npm run check
```

The package builds to `dist/`; generated artifacts and dependencies are not
tracked in git.
