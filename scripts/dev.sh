#!/bin/bash
set -e

# Ensure node_modules/.bin is in PATH (for when script runs directly)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$SCRIPT_DIR/../node_modules/.bin:$PATH"

# Find available ports with sequential fallback
DAEMON_PORT=$(get-port 6767 6768 6769 6770 6771 6772 6773)
METRO_PORT=$(get-port 8081 8082 8083 8084 8085 8086 8087)

# # Use a temporary PASEO_HOME to avoid conflicts between dev instances
# export PASEO_HOME=$(mktemp -d "${TMPDIR:-/tmp}/paseo-dev.XXXXXX")
# trap "rm -rf '$PASEO_HOME'" EXIT

# Build CORS origins for this Expo instance
CORS_ORIGINS="http://localhost:${METRO_PORT},http://127.0.0.1:${METRO_PORT}"

# Configure app to auto-connect to this daemon
EXPO_DAEMONS="[{\"label\":\"localhost\",\"endpoint\":\"localhost:${DAEMON_PORT}\"}]"

echo "══════════════════════════════════════════════════════"
echo "  Paseo Dev"
echo "══════════════════════════════════════════════════════"
echo "  Daemon:  http://localhost:${DAEMON_PORT}"
echo "  Metro:   http://localhost:${METRO_PORT}"
# echo "  Home:    ${PASEO_HOME}"
echo "══════════════════════════════════════════════════════"

# Export for child processes (overrides .env values)
export PASEO_LISTEN="0.0.0.0:${DAEMON_PORT}"
export PASEO_CORS_ORIGINS="${CORS_ORIGINS}"

# Run both with concurrently
# BROWSER=none prevents auto-opening browser
# EXPO_PUBLIC_DAEMONS configures the app to auto-connect to this daemon
concurrently \
  --names "daemon,metro" \
  --prefix-colors "cyan,magenta" \
  "npm run dev:server" \
  "BROWSER=none EXPO_PUBLIC_DAEMONS='${EXPO_DAEMONS}' npm run start --workspace=@paseo/app -- --port ${METRO_PORT}"
