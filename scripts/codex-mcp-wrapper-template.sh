#!/usr/bin/env bash
set -euo pipefail

REAL_CODEX="__REAL_CODEX__"
MCP_URL="__MCP_URL__"
MCP_BEARER="__MCP_BEARER__"
DEV_INSTRUCTIONS="__DEV_INSTRUCTIONS__"

ARGS=()
if [[ -n "$MCP_URL" ]]; then
  ARGS+=(-c "mcp_servers.agent_control.url=\"$MCP_URL\"")
fi
if [[ -n "$MCP_BEARER" ]]; then
  export PASEO_MCP_BEARER="$MCP_BEARER"
  ARGS+=(-c "mcp_servers.agent_control.bearer_token_env_var=\"PASEO_MCP_BEARER\"")
fi
if [[ -n "$DEV_INSTRUCTIONS" ]]; then
  ARGS+=(-c "developer_instructions=\"$DEV_INSTRUCTIONS\"")
fi

exec "$REAL_CODEX" "${ARGS[@]}" "$@"
