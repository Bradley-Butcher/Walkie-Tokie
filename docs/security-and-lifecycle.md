# Security and Lifecycle

## Threat Model

This tool allows one developer's agent to ask questions of another developer's
parked Codex session. That is powerful. Tailscale narrows network reachability,
but it is not the whole permission model.

Assume:

- tailnet peers are not all equally trusted
- agents can misunderstand instructions
- review prompts may accidentally ask for secrets
- workspaces may contain credentials or private notes
- a reviewer might ask a question while the author has resumed active work

## Required Controls

### Explicit Review Mode

The author must opt in:

```shell
walkie-tokie review-mode start \
  --target brad/withcoral/coral#1234 \
  --repo withcoral/coral \
  --pr 1234 \
  --session big-brain-bert \
  --allow pawel \
  --capability inspect
```

No review mode, no remote questions.

### Tailscale Bind

For the colleague workflow, `wait_for_message` ensures `walkie-tokied` is
running and binds it to the author's Tailscale IPv4 address:

```shell
WALKIE_TOKIE_HOST="$(tailscale ip -4)" WALKIE_TOKIE_PORT=8787 walkie-tokied
```

That command is what the MCP starts internally. It is shown here to document the
runtime shape, not as the normal user workflow.

The daemon refuses wildcard binds such as `0.0.0.0` unless
`WALKIE_TOKIE_TOKEN` is set or the operator explicitly opts out with
`WALKIE_TOKIE_ALLOW_UNAUTHENTICATED=1`.

Tokens are an escape hatch, not the happy path. The intended v0 trust boundary is
Tailscale reachability plus per-endpoint allowlists. The next version should map
Tailscale peer identity into the relay policy instead of trusting a
client-supplied caller name.

### Per-Session Lease

Review mode is an exclusive lease over the session.

Remote requests are accepted only while review mode is active. The author agent
must also run `wait_for_review_request` to receive work. When the author resumes
active work, the relay should move the lease to `paused` or require a fresh
`review-mode resume`.

### Caller Allowlist

Policy should name allowed callers, not just allowed machines.

The relay can use Tailscale peer identity as an input, then map it to local
policy names such as `pawel`.

Current prototype caveat: `caller.user` is still supplied by the client. Use this
only with trusted reviewers on your tailnet until Tailscale identity mapping
lands.

### Capability Allowlist

Each review endpoint declares allowed capabilities.

The first version should avoid `write`. If `verify` is enabled, command
execution must be allowlisted.

### Secret Redaction

The relay should never send environment variables, local config, or arbitrary
files to the reviewer. The Codex prompt should explicitly forbid exposing
secrets. Audit logs should store prompt hashes by default, with full prompt
storage as an opt-in.

### Audit Log

Audit events are not optional.

Use append-only JSONL first:

```json
{
  "ts": "2026-05-13T12:00:00Z",
  "event": "review_request_completed",
  "request_id": "req_01JZ...",
  "caller": "pawel",
  "target": "brad/withcoral/coral#1234",
  "session": "big-brain-bert",
  "mode": "inspect",
  "status": "completed"
}
```

### Timeouts

Every request needs a deadline. Default to five minutes. Let the author choose a
larger timeout for expensive verification.

## Blocking Hooks, Not Polling

The relay should be event-driven.

The author-side daemon receives the network request, validates it, and either
delivers it to an already-blocked `wait_for_review_request` call or queues it
behind the current in-flight request. That is the hook.

There is no need for the Codex session to poll an inbox. The author's visible
Codex turn is blocked on a tool call. The reviewer's visible Codex turn is
blocked on a matching tool call. The relay connects those waits.

## Codex Integration Levels

### Level 0: Local MCP Tools

Use MCP tools inside the visible Codex sessions.

Reviewer side:

- `list_review_endpoints`
- `ask_review_peer`
- `cancel_review_request`

Author side:

- `wait_for_review_request`
- `reply_to_review_request`
- `close_review_mode`

This is the primary design because it preserves the app-visible transcript
without needing to control Codex Desktop from the outside.

### Level 1: Convenience Tool

Add `answer_and_wait` after the explicit primitives work. It should submit an
answer and immediately block for the next request. This improves ergonomics but
must not be required for correctness; a request that arrives between reply and
wait should already be safely queued by the relay.

### Level 2: Native Review Hook

Codex grows a first-class "park this session and wake on event" hook. That could
replace the author-side MCP wait tool later, but the relay should not depend on
it at the start.

## OpenTelemetry

The relay should emit spans for:

- request receive
- policy validation
- queue wait
- session lock acquire
- author wait delivery
- response streaming
- audit write

Recommended span attributes:

- `review.request_id`
- `review.repo`
- `review.pr`
- `review.session`
- `review.mode`
- `review.caller`
- `review.state`
- `review.queue_position`

Do not put prompt text or answers in span attributes.

## Validation

Validate all external request fields:

- target syntax
- known endpoint
- allowed caller
- allowed capability
- timeout bounds
- relay TTL bounds
- question size
- idempotency key size
- session state

Validation should happen before session lock acquisition where possible.

## Failure Modes

### Not In Review Mode

Reject immediately. The reviewer-side blocking call should return a structured
rejection, not wait for a future review-mode start.

### Agent Busy

Queue by default, up to a small bound.

The reviewer-side MCP call stays blocked while the request is queued. It returns
only when answered, rejected, cancelled, or timed out.

### Queue Full

Return `busy`.

This is backpressure. It prevents one reviewer or buggy agent from filling a
long stale queue.

### Author Resumes Work

Move the lease to `paused`. New remote requests return `paused`. Existing queued
requests should be cancelled or expired, not silently delivered later.

### Review Mode Closed Or Restarted

Closing review mode cancels queued requests and any request already delivered to
the author. Restarting the same endpoint also clears stale waits and stale
requests before creating the fresh lease.

### Author Wait Disconnects

If no request was delivered yet, just remove the waiter. If a request was
delivered and the author-side tool call disconnects before a reply, mark the
request `waiter_disconnected` and notify the reviewer.

### Network Disconnect

If the reviewer-side connection drops, keep the request alive until its relay
TTL unless the caller explicitly cancelled. A reconnect endpoint may attach to
the request event stream.
