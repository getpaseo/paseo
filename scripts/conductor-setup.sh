#!/bin/bash
# conductor-setup.sh — setup script for Conductor-managed workspaces
#
# Conductor provides:
#   CONDUCTOR_WORKSPACE_NAME — workspace name (e.g. "san-diego")
#   CONDUCTOR_PORT           — base port assigned to this workspace
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Sanitize workspace name: lowercase, replace non-alphanumeric with underscores
RAW_NAME="${CONDUCTOR_WORKSPACE_NAME:-default}"
SANITIZED="$(echo "$RAW_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/_/g' | sed 's/__*/_/g' | sed 's/^_//;s/_$//')"
export WORKSPACE_NAME="junction_${SANITIZED}"

# Derive ports from CONDUCTOR_PORT (base port)
BASE_PORT="${CONDUCTOR_PORT:-6767}"
export DAEMON_PORT="$BASE_PORT"
export API_PORT="$((BASE_PORT + 1))"
export APP_PORT="$((BASE_PORT + 2))"

# Set JUNCTION_HOME for workspace isolation
export JUNCTION_HOME="${HOME}/.junction-conductor-${SANITIZED}"

echo "Conductor workspace: ${RAW_NAME} → ${WORKSPACE_NAME}"
echo "Ports: daemon=${DAEMON_PORT}, api=${API_PORT}, app=${APP_PORT}"
echo "JUNCTION_HOME: ${JUNCTION_HOME}"

# Run shared setup
source "$SCRIPT_DIR/setup-common.sh"
