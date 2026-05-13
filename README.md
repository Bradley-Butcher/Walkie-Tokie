# Walkie Tokie

Agent-to-agent review questions for parked coding sessions.

Walkie Tokie lets a reviewer agent ask questions of the author's parked agent
while a PR is waiting for review. The goal is to keep review moving without
forcing the author to stay online as the human relay.

## Workflow

1. The author works on a PR with their agent.
2. When the PR is ready, the author parks that agent in "Waiting for Review"
   mode and shares a recipient string in the PR:

   ```text
   walkie-tokie/alice-laptop/review-pr-123
   ```

3. A reviewer comes along and checks out the PR with their own agent.
4. If the reviewer or reviewer agent has a question about intent, motivation,
   tradeoffs, or expected behavior, they paste the recipient string and ask:

   ```text
   walkie-tokie/alice-laptop/review-pr-123 Why does this validation live here?
   ```

5. The reviewer's agent sends the question to the parked author agent and waits
   for an answer.
6. The parked author agent answers from its original PR context. It can explain
   the work, point at evidence, or say that a change is probably needed.
7. Later, the author comes back to one conversation: their agent has handled the
   reviewer questions and can summarize any agreed follow-up changes.
8. The author greenlights the changes or takes back control.

The author explicitly enters review mode. Walkie Tokie is not a general inbox or
background task runner.

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
- a stdio MCP server with `send_message` and `wait_for_message`
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

## Development

```shell
npm ci
npm run check
```

The package builds to `dist/`; generated artifacts and dependencies are not
tracked in git.
