#!/bin/bash
set -e

# Ensure node_modules/.bin is in PATH (for when script runs directly)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$SCRIPT_DIR/../node_modules/.bin:$PATH"

# Find available ports with sequential fallback
DAEMON_PORT=$(get-port 6767 6768 6769 6770 6771 6772 6773)
METRO_PORT=$(get-port 8081 8082 8083 8084 8085 8086 8087)

# Use a temporary JUNCTION_HOME to avoid conflicts between dev instances
# export JUNCTION_HOME=$(mktemp -d "${TMPDIR:-/tmp}/junction-dev.XXXXXX")
# trap "rm -rf '$JUNCTION_HOME'" EXIT

# Build CORS origins for this Expo instance
CORS_ORIGINS="http://localhost:${METRO_PORT},http://127.0.0.1:${METRO_PORT}"

# Configure app to auto-connect to this daemon
LOCAL_DAEMON="localhost:${DAEMON_PORT}"

echo "══════════════════════════════════════════════════════"
echo "  Junction Dev"
echo "══════════════════════════════════════════════════════"
echo "  Daemon:  http://localhost:${DAEMON_PORT}"
echo "  Metro:   http://localhost:${METRO_PORT}"
# echo "  Home:    ${JUNCTION_HOME}"
echo "══════════════════════════════════════════════════════"

# Export for child processes (overrides .env values)
export JUNCTION_LISTEN="0.0.0.0:${DAEMON_PORT}"
export JUNCTION_CORS_ORIGINS="${CORS_ORIGINS}"

# Run both with concurrently
# BROWSER=none prevents auto-opening browser
# EXPO_PUBLIC_LOCAL_DAEMON configures the app to auto-connect to this daemon
concurrently \
  --names "daemon,metro" \
  --prefix-colors "cyan,magenta" \
  "npm run dev:server" \
  "BROWSER=none EXPO_PUBLIC_LOCAL_DAEMON='${LOCAL_DAEMON}' npm run start --workspace=@junction/app -- --port ${METRO_PORT}"
