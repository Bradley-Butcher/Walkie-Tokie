# Protocol

## Design Choice

MCP is the local tool interface on both sides. It should not be the network
protocol.

The network protocol between relays should be a small HTTP or gRPC API running
over Tailscale. HTTP JSON with streaming is enough for the first version. gRPC
can follow if typed bidirectional streaming and generated clients become
valuable.

The important shape is blocking, not polling:

- reviewer agent calls `send_message(to, message)` and waits for the answer
- author agent calls `wait_for_review_request` and waits for the next question
- author agent calls `reply_to_review_request` with the answer
- relay queues only as an implementation detail while those blocking calls are
  not both present at the same time

## MCP Fit

This is a good MCP shape because each tool is local to the agent using it:

- Pawel's Codex gets a local `send_message` tool.
- Brad's Codex gets local `wait_for_review_request` and
  `reply_to_review_request` tools.
- The relay protocol over Tailscale stays separate from MCP.

The prototype uses the official TypeScript MCP SDK,
`@modelcontextprotocol/sdk`, with a stdio transport. That is the right library
to start with because Codex already speaks stdio MCP, and the server can be a
thin adapter around the relay HTTP client.

Long-running tool calls are acceptable as the intended user experience here,
but they need real timeout and cancellation semantics. The reviewer should set a
human-scale timeout, such as 10 or 15 minutes. The author wait can be much
longer, such as 12 hours, because it is the explicit review-mode posture.

The MCP tools should return structured results, not free-form text only. That
lets the agent distinguish `answered`, `timeout`, `rejected`, and `cancelled`
without guessing from prose.

## Endpoint Identity

A review endpoint is identified by:

```text
author/owner/repo#pr
```

Example:

```text
brad/withcoral/coral#1234
```

The relay maps that to:

```json
{
  "repo": "withcoral/coral",
  "pr": 1234,
  "session": "big-brain-bert",
  "state": "waiting"
}
```

## Reviewer MCP Tools

### `send_message`

Submits a message to a named review session on a Tailscale host and blocks until
the author agent answers, rejects, closes review mode, or the timeout expires.

Input:

```json
{
  "to": "brad-laptop/big-lad-john",
  "message": "What invariant makes this migration safe?",
  "mode": "inspect",
  "timeoutSeconds": 300
}
```

Output:

```json
{
  "requestId": "req_01JZ...",
  "status": "answered",
  "answer": "The migration is safe because..."
}
```

This is the preferred reviewer-facing tool. The older `ask_review_peer` tool is
kept as a lower-level endpoint-addressed primitive.

### `list_review_endpoints`

Returns endpoints the reviewer is allowed to contact.

Current prototype output:

```json
{
  "endpoints": [
    {
      "target": "brad/withcoral/coral#1234",
      "repo": "withcoral/coral",
      "pr": 1234,
      "session": "big-brain-bert",
      "state": "review_idle",
      "capabilities": ["inspect"],
      "allowedCallers": ["pawel"],
      "maxPending": 8
    }
  ]
}
```

### `start_review_mode`

Author-side setup tool. Creates or replaces the review endpoint.

Input:

```json
{
  "target": "brad/withcoral/coral#1234",
  "repo": "withcoral/coral",
  "pr": 1234,
  "session": "big-brain-bert",
  "allowedCallers": ["pawel"],
  "capabilities": ["inspect"],
  "maxPending": 8
}
```

Output:

```json
{
  "endpoint": {
    "target": "brad/withcoral/coral#1234",
    "repo": "withcoral/coral",
    "pr": 1234,
    "session": "big-brain-bert",
    "state": "review_idle",
    "capabilities": ["inspect"],
    "allowedCallers": ["pawel"],
    "maxPending": 8
  }
}
```

### `ask_review_peer`

Lower-level primitive that submits a question to a specific endpoint id and
blocks until the author agent answers, rejects, closes review mode, or the
timeout expires.

Input:

```json
{
  "target": "brad/withcoral/coral#1234",
  "question": "What invariant makes this migration safe?",
  "mode": "inspect",
  "timeoutSeconds": 300
}
```

Output:

```json
{
  "requestId": "req_01JZ...",
  "status": "answered",
  "answer": "The migration is safe because..."
}
```

Timeout output:

```json
{
  "requestId": "req_01JZ...",
  "status": "timeout",
  "message": "No answer arrived before the reviewer timeout."
}
```

Rejected output:

```json
{
  "status": "rejected",
  "reason": "not_in_review_mode",
  "message": "Brad's author agent is not currently accepting review questions."
}
```

### `cancel_review_request`

Requests cancellation of an outstanding blocking ask. Cancellation is
best-effort because the author agent may already be working on the request.

## Author MCP Tools

### `wait_for_review_request`

Blocks the visible author Codex session until the next allowed review request
arrives, the timeout expires, or review mode closes.

Input:

```json
{
  "endpoint": "brad/withcoral/coral#1234",
  "timeoutSeconds": 43200
}
```

Output when a request arrives:

```json
{
  "status": "request",
  "request": {
    "requestId": "req_01JZ...",
    "target": "brad/withcoral/coral#1234",
    "question": "What invariant makes this migration safe?",
    "mode": "inspect",
    "origin": {
      "user": "pawel",
      "agent": "pawel-codex",
      "machine": "pawel-mbp.tailnet"
    },
    "deadline": "2026-05-13T14:30:00Z"
  }
}
```

Output on timeout:

```json
{
  "status": "timeout"
}
```

### `wait_for_message`

Author-side blocking wait using the public review session name instead of the
lower-level endpoint id. This is the preferred author-facing tool.

If the local relay daemon is not running, the MCP server starts it on the
author's Tailscale IP. If the named review session is not active yet, the tool
can create review mode before waiting.

Input:

```json
{
  "session_name": "big-lad-john",
  "repo": "withcoral/coral",
  "pr": 1234,
  "allowedCallers": ["pawel"],
  "capabilities": ["inspect"],
  "timeoutSeconds": 43200
}
```

Output has the same shape as `wait_for_review_request`.

### `reply_to_review_request`

Completes the request and releases the reviewer-side blocking call.

Input:

```json
{
  "requestId": "req_01JZ...",
  "answer": "The migration is safe because...",
  "evidence": [
    {
      "kind": "file",
      "path": "crates/example/src/lib.rs",
      "line": 42
    }
  ]
}
```

Output:

```json
{
  "status": "sent",
  "requestId": "req_01JZ..."
}
```

### `close_review_mode`

Closes the endpoint and cancels queued requests.

Input:

```json
{
  "target": "brad/withcoral/coral#1234"
}
```

Output:

```json
{
  "target": "brad/withcoral/coral#1234",
  "status": "closed"
}
```

### `answer_and_wait`

Optional convenience tool. It combines `reply_to_review_request` followed by
`wait_for_review_request`. It should be added after the explicit primitives are
implemented and tested.

## Relay HTTP API

### `GET /v1/review-endpoints`

Returns endpoints visible to the authenticated caller.

All relay HTTP endpoints except `/healthz` accept an optional `Authorization:
Bearer <WALKIE_TOKIE_TOKEN>` header when the author daemon is configured with
`WALKIE_TOKIE_TOKEN`.

For normal colleague use, no token is required. Bind the daemon to the author's
Tailscale IPv4 address. The daemon refuses wildcard binds such as `0.0.0.0`
without a token or explicit opt-out.

### `POST /v1/review-requests:wait`

Creates a review request and holds the connection open until the request is
answered, rejected, cancelled, or the caller timeout expires.

Request:

```json
{
  "target": "brad/withcoral/coral#1234",
  "question": "Why is validation below the gRPC boundary?",
  "mode": "inspect",
  "clientRequestId": "optional-idempotency-key",
  "timeoutSeconds": 300,
  "caller": {
    "user": "pawel",
    "agent": "pawel-codex"
  }
}
```

Response:

```json
{
  "requestId": "req_01JZ...",
  "status": "answered",
  "answer": "Validation lives below the gRPC boundary because..."
}
```

### `POST /v1/sessions/{sessionName}/messages/wait`

Session-addressed version of `POST /v1/review-requests:wait`. This is what
`send_message` calls after resolving `to`, such as
`brad-laptop/big-lad-john`, into an author relay URL and session name.

Request:

```json
{
  "message": "Why is validation below the gRPC boundary?",
  "mode": "inspect",
  "timeoutSeconds": 300,
  "caller": {
    "user": "pawel",
    "agent": "pawel-codex"
  }
}
```

Response:

```json
{
  "requestId": "req_01JZ...",
  "status": "answered",
  "answer": "Validation lives below the gRPC boundary because..."
}
```

### `POST /v1/sessions/{sessionName}/wait`

Session-addressed version of the author wait endpoint.

### `GET /v1/review-requests/{requestId}/events`

Optional reconnect/debug endpoint. It streams request lifecycle events if the
reviewer-side MCP call disconnects or wants progress messages.

Initial event names:

- `accepted`
- `queued`
- `delivered_to_author`
- `author_started_answer`
- `completed`
- `failed`
- `cancelled`
- `expired`

### `POST /v1/review-requests/{requestId}/reply`

Author-side endpoint used by the author MCP server to complete a request.

### `POST /v1/review-requests/{requestId}/cancel`

Requests cancellation.

## Framed Request

The author MCP server should not return the remote question naked. It should
frame the request so the transcript is readable and policy is clear.

Example:

```text
Remote review request

Reviewer: pawel
Repository: withcoral/coral
PR: 1234
Mode: inspect
Policy: You may answer questions about this PR. You may inspect files and diffs.
Do not write files. Do not expose secrets. If the request needs broader access,
explain the limitation.

Question:
Why is validation below the gRPC boundary instead of in the handler?
```

## Queue Semantics

The reviewer API remains blocking even when the relay queues internally.

- If review mode is closed or paused, reject immediately.
- If an author wait call is open, deliver immediately.
- If the author is answering another request, enqueue up to a small bound.
- If the queue is full, reject with `busy`.
- Each request has a reviewer timeout and a relay TTL.
- When the author calls `wait_for_review_request`, the oldest valid queued
  request is returned immediately.

This avoids polling while still handling the gap between
`reply_to_review_request` and the next `wait_for_review_request`.

## Errors

Errors should be boring and precise.

- `not_found`: no endpoint matches the target
- `not_allowed`: caller is not allowed
- `not_in_review_mode`: author has not enabled review mode
- `paused`: author paused review mode
- `busy`: queue is full or one request is already in flight and queueing is disabled
- `unsupported_mode`: requested capability is not enabled
- `timeout`: no answer arrived before the deadline
- `waiter_disconnected`: author wait call disconnected while a request was being delivered
- `invalid_request`: input failed validation

The reviewer MCP server should turn these into plain language, but preserve the
machine code for debugging.

## Versioning

Every request should include:

```json
{
  "protocol_version": "2026-05-13"
}
```

That is intentionally date-based while the design is early. Once the contract
stabilizes, move to `v1`.
