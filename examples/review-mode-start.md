# Example: Park A Session For Review

Everyone installs the MCP once:

```shell
walkie-tokie mcp install
```

Author's Codex session:

```json
{
  "tool": "wait_for_message",
  "session_name": "big-brain-bert",
  "repo": "withcoral/coral",
  "pr": 1234,
  "allowedCallers": ["pawel"],
  "capabilities": ["inspect"],
  "timeoutSeconds": 43200
}
```

`wait_for_message` starts the local relay daemon if needed, creates review mode
if needed, then waits.

Reviewer:

```text
Ask Brad's author agent why the new validation lives below the gRPC boundary.
```

Reviewer-side MCP tool call:

```json
{
  "to": "brad-laptop/big-brain-bert",
  "message": "Why does this validation live below the gRPC boundary?",
  "mode": "inspect",
  "timeoutSeconds": 900
}
```

Author-side wait result:

```json
{
  "status": "request",
  "request": {
    "requestId": "req_01JZ...",
    "target": "brad/withcoral/coral#1234",
    "question": "Why does this validation live below the gRPC boundary?",
    "mode": "inspect",
    "origin": {
      "user": "pawel",
      "agent": "pawel-codex"
    }
  }
}
```

Author-side reply:

```json
{
  "requestId": "req_01JZ...",
  "answer": "It lives below the gRPC boundary because..."
}
```

Reviewer-side tool result:

```json
{
  "requestId": "req_01JZ...",
  "status": "answered",
  "answer": "It lives below the gRPC boundary because..."
}
```
