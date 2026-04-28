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
  --external:@hubcode/server --external:@hubcode/cli

# Use fixed port for Metro (so share links work consistently)
EXPO_PORT="${EXPO_PORT:-8081}"
export EXPO_PORT

# Allow the Metro dev origin so the Electron renderer can connect to the daemon WebSocket
export HUBCODE_CORS_ORIGINS="http://localhost:${EXPO_PORT}"

# Auth server URL — used by:
#   1. The Electron main process (this script's electron child env).
#   2. The daemon spawned by main (HUBCODE_AUTH_SERVER_URL is forwarded).
#   3. The renderer (React app) via EXPO_PUBLIC_HUBCODE_AUTH_URL — Expo
#      inlines EXPO_PUBLIC_* at bundle time, so we mirror the value here
#      so all three layers stay in sync. To run desktop dev against
#      production hubcode.ai, set HUBCODE_AUTH_SERVER_URL=https://auth.hubcode.ai
#      before invoking this script.
export HUBCODE_AUTH_SERVER_URL="${HUBCODE_AUTH_SERVER_URL:-http://localhost:3002}"
export EXPO_PUBLIC_HUBCODE_AUTH_URL="${EXPO_PUBLIC_HUBCODE_AUTH_URL:-$HUBCODE_AUTH_SERVER_URL}"

echo "══════════════════════════════════════════════════════"
echo "  Hubcode Desktop Dev"
echo "══════════════════════════════════════════════════════"
echo "  Metro:     http://localhost:${EXPO_PORT}"
echo "══════════════════════════════════════════════════════"

# Set HUBCODE_PROD_MODE=1 to bundle the renderer with __DEV__=false, so code
# branches like getColyseusUrl() pick prod URLs instead of localhost. The
# Electron wrapper still runs unpackaged (devtools, hot file watch), but the
# renderer behaves as it would in a production build.
EXPO_FLAGS=""
if [ "${HUBCODE_PROD_MODE:-0}" = "1" ]; then
  EXPO_FLAGS="--no-dev --minify"
  echo "  Mode:      PROD (--no-dev --minify, __DEV__=false)"
  echo "══════════════════════════════════════════════════════"
fi

# Launch Metro + Electron together, kill both on exit
"$ROOT_DIR/node_modules/.bin/concurrently" \
  --kill-others \
  --names "metro,electron" \
  --prefix-colors "magenta,cyan" \
  "cd '$APP_DIR' && npx expo start --port $EXPO_PORT $EXPO_FLAGS" \
  "$ROOT_DIR/node_modules/.bin/wait-on tcp:$EXPO_PORT && EXPO_DEV_URL=http://localhost:$EXPO_PORT HUBCODE_AUTH_SERVER_URL=$HUBCODE_AUTH_SERVER_URL $ROOT_DIR/node_modules/.bin/electron '$DESKTOP_DIR'"
