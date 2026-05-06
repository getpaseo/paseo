#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$(cd "$DESKTOP_DIR/../app" && pwd)"
ROOT_DIR="$(cd "$DESKTOP_DIR/../.." && pwd)"

# Build the Electron main process
npm run build:main

# Prefer Metro's stable default port so dev browser storage keeps the same
# localhost origin across restarts. Fall back only when earlier ports are busy.
EXPO_PORT=$("$ROOT_DIR/node_modules/.bin/get-port" 8081 8082 8083 8084 8085)
export EXPO_PORT

# Allow any origin in dev so Electron on random localhost ports can reach
# the daemon websocket. Safe here because this script is development-only
# and the daemon still binds to localhost.
export PASEO_CORS_ORIGINS="*"

echo "══════════════════════════════════════════════════════"
echo "  Paseo Desktop Dev"
echo "══════════════════════════════════════════════════════"
echo "  Metro:     http://localhost:${EXPO_PORT}"
echo "══════════════════════════════════════════════════════"

# Launch Metro + Electron together, kill both on exit
exec "$ROOT_DIR/node_modules/.bin/concurrently" \
  --kill-others \
  --names "metro,electron" \
  --prefix-colors "magenta,cyan" \
  "cd '$APP_DIR' && PASEO_WEB_PLATFORM=electron npx expo start --port $EXPO_PORT" \
  "$ROOT_DIR/node_modules/.bin/wait-on tcp:$EXPO_PORT && EXPO_DEV_URL=http://localhost:$EXPO_PORT electron '$DESKTOP_DIR'"
