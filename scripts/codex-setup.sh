#!/bin/bash
# codex-setup.sh — setup script for Codex worktrees
#
# Codex worktrees live at: ~/.codex/worktrees/<id>/junction
# We extract the workspace ID from the current working directory path.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Extract workspace ID from path
# Pattern: ~/.codex/worktrees/<id>/...
if [[ "$REPO_ROOT" =~ \.codex/worktrees/([^/]+) ]]; then
  WORKTREE_ID="${BASH_REMATCH[1]}"
else
  # Fallback: use a hash of the repo path
  WORKTREE_ID="$(echo "$REPO_ROOT" | md5sum 2>/dev/null | cut -c1-8 || echo "$REPO_ROOT" | md5 2>/dev/null | cut -c1-8 || echo "default")"
fi

SANITIZED="$(echo "$WORKTREE_ID" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/_/g' | sed 's/__*/_/g' | sed 's/^_//;s/_$//')"
export WORKSPACE_NAME="junction_codex_${SANITIZED}"

# Static default ports for Codex (worktree provides filesystem isolation)
export DAEMON_PORT="${DAEMON_PORT:-6767}"
export API_PORT="${API_PORT:-3100}"
export APP_PORT="${APP_PORT:-5173}"

# Isolated JUNCTION_HOME
export JUNCTION_HOME="${HOME}/.junction-codex-${SANITIZED}"

echo "Codex worktree: ${WORKTREE_ID} → ${WORKSPACE_NAME}"
echo "Ports: daemon=${DAEMON_PORT}, api=${API_PORT}, app=${APP_PORT}"
echo "JUNCTION_HOME: ${JUNCTION_HOME}"

# Run shared setup
source "$SCRIPT_DIR/setup-common.sh"

# Print environment.toml snippet for user
echo ""
echo "══════════════════════════════════════════════════════"
echo "  Codex environment.toml"
echo "══════════════════════════════════════════════════════"
echo ""
echo "Add the following to your Codex environment.toml:"
echo ""
echo "[env]"
echo "JUNCTION_HOME = \"${JUNCTION_HOME}\""
echo "JUNCTION_LISTEN = \"127.0.0.1:${DAEMON_PORT}\""
echo "DATABASE_URL = \"postgresql://postgres:postgres@localhost:5435/${WORKSPACE_NAME}\""
echo "API_PORT = \"${API_PORT}\""
echo "APP_PORT = \"${APP_PORT}\""
echo ""
