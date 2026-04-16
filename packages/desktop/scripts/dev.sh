#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$(cd "$DESKTOP_DIR/../app" && pwd)"
ROOT_DIR="$(cd "$DESKTOP_DIR/../.." && pwd)"

# Build the Electron main process (esbuild for speed — tsc OOMs on this monorepo)
cd "$DESKTOP_DIR"
npx esbuild src/main.ts src/preload.ts --outdir=dist --platform=node --format=cjs --bundle \
  --external:electron --external:electron-updater --external:electron-log --external:ws \
  --external:@hubtool/server --external:@hubtool/cli

# Get a random available port for Metro
EXPO_PORT=$("$ROOT_DIR/node_modules/.bin/get-port")
export EXPO_PORT

# Allow the Metro dev origin so the Electron renderer can connect to the daemon WebSocket
export HUBCODE_CORS_ORIGINS="http://localhost:${EXPO_PORT}"

# Auth server URL (defaults to production — override for local dev)
export HUBCODE_AUTH_SERVER_URL="${HUBCODE_AUTH_SERVER_URL:-http://localhost:3002}"

echo "══════════════════════════════════════════════════════"
echo "  Hubcode Desktop Dev"
echo "══════════════════════════════════════════════════════"
echo "  Metro:     http://localhost:${EXPO_PORT}"
echo "══════════════════════════════════════════════════════"

# Launch Metro + Electron together, kill both on exit
"$ROOT_DIR/node_modules/.bin/concurrently" \
  --kill-others \
  --names "metro,electron" \
  --prefix-colors "magenta,cyan" \
  "cd '$APP_DIR' && npx expo start --port $EXPO_PORT" \
  "$ROOT_DIR/node_modules/.bin/wait-on tcp:$EXPO_PORT && EXPO_DEV_URL=http://localhost:$EXPO_PORT HUBCODE_AUTH_SERVER_URL=$HUBCODE_AUTH_SERVER_URL $ROOT_DIR/node_modules/.bin/electron '$DESKTOP_DIR'"
