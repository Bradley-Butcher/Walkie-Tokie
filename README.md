# Walkie Tokie

Agent-to-agent review questions for parked coding sessions.

Walkie Tokie lets one agent send a blocking review question to another agent
that has explicitly entered review mode. The first implementation provides:

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
