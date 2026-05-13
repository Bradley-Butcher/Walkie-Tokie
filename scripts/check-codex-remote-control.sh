#!/usr/bin/env bash
set -euo pipefail

codex_home="${CODEX_HOME:-$HOME/.codex}"
state_db="$codex_home/state_5.sqlite"

echo "== feature flag =="
codex features list | rg '^remote_control|^tui_app_server' || true

echo
echo "== app-server processes =="
ps aux | rg -i '/codex app-server|Codex.app' | rg -v 'rg -i' || true

echo
echo "== listeners/sockets =="
lsof -Pan -i -U | rg -i 'codex|app-server|remote' || true

echo
echo "== default proxy socket =="
ls -la "$codex_home/app-server-control" 2>/dev/null || true
find "$codex_home" -maxdepth 3 -type s -print 2>/dev/null || true

echo
echo "== remote-control enrollments =="
if [[ -f "$state_db" ]]; then
  sqlite3 -header -column "$state_db" 'select * from remote_control_enrollments limit 20;' || true
else
  echo "state DB not found: $state_db"
fi

