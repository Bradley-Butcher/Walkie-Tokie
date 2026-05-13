# ADR 0001: Parked Live Session

Date: 2026-05-13

## Status

Proposed

## Context

The author wants to make their agent available to a reviewer and the reviewer's
agent after opening a PR.

An isolated support session is safer, but loses an important property: the
author wants to resume the same useful context later and ideally see the review
activity from the Codex app.

Letting remote agents inject into any live authoring session is too broad. It
has poor lifecycle semantics when the author is actively working.

## Decision

Use the author's real Codex session as the review endpoint only after the author
explicitly parks it in review mode.

Review mode grants an exclusive lease to the relay:

- the author's visible Codex session may block in `wait_for_review_request`
- remote reviewer agents may submit blocking `ask_review_peer` calls
- remote questions are returned into the author's visible session as tool output
- author answers are sent with `reply_to_review_request`
- the relay serializes and lightly queues requests
- the author can pause or close the lease
- requests are accepted only while review mode is active

## Consequences

The author gets one coherent session history. Review exchanges are not hidden in
an external queue.

The relay needs a real state machine and a per-session lock. That is the cost of
using the live session safely.

The design does not require external control of Codex Desktop. That is the main
benefit of using a blocking local tool inside the visible session.

The relay still needs careful timeout, cancellation, and queue semantics because
both sides are holding long-running tool calls.

## Rejected Alternatives

### Always Use An Isolated Review Session

This is clean operationally, but weaker for the author workflow. It creates a
second thread that the author has to reconcile later.

### Allow Remote Messages Into Any Active Session

This creates unclear ownership. The author might be editing, the agent might be
mid-tool-call, and a reviewer question could arrive at the wrong moment.

### Wake The Open Codex App Tab From Outside

This would be elegant if Codex Desktop exposed a stable local control hook, but
the current app-server/remote-control surfaces do not provide that hook. It also
gives the relay more power than it needs.

### Use MCP Across The Tailnet

MCP is a good local tool protocol for each agent. It should not also be the
cross-machine security and lifecycle protocol.
