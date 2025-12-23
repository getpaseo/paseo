#!/usr/bin/env bash
set -euo pipefail

REAL_CODEX="__REAL_CODEX__"
MCP_URL="__MCP_URL__"

if [[ -n "$MCP_URL" ]]; then
  exec "$REAL_CODEX" -c "mcp_servers.agent_control.url=\"$MCP_URL\"" "$@"
fi

exec "$REAL_CODEX" "$@"
