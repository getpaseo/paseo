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
EXPO_PORT=$(NO_COLOR=1 FORCE_COLOR=0 "$ROOT_DIR/node_modules/.bin/get-port" 8081 8082 8083 8084 8085)
export EXPO_PORT

REMOTE_DEBUGGING_PORT="${PASEO_ELECTRON_REMOTE_DEBUGGING_PORT:-9223}"
export PASEO_ELECTRON_FLAGS="${PASEO_ELECTRON_FLAGS:+$PASEO_ELECTRON_FLAGS }--remote-debugging-port=$REMOTE_DEBUGGING_PORT"

# Allow any origin in dev so Electron on random localhost ports can reach
# the daemon websocket. Safe here because this script is development-only
# and the daemon still binds to localhost.
export PASEO_CORS_ORIGINS="*"

# Fully isolate the dev instance from a production Paseo install so `npm run dev`
# works while the installed app is open. Without this the dev build (a) loses the
# Electron single-instance lock to the installed app and quits, and (b) ends up
# pointed at the production daemon, whose CORS allowlist rejects the Metro origin.
# PASEO_HOME defaults to a script-managed dev home. If you override it (to point
# dev at real data), we DON'T touch your config.json — only the managed home gets
# its daemon config seeded below, so we never rewrite a production ~/.paseo config.
#   - PASEO_ELECTRON_USER_DATA_DIR: a separate Electron profile → separate
#     single-instance lock, so dev and the installed app coexist.
#   - PASEO_LISTEN: a distinct port so the dev daemon never collides with prod's 6767.
DEV_STATE_DIR="$DESKTOP_DIR/.dev"
if [ -n "${PASEO_HOME:-}" ]; then
  PASEO_HOME_MANAGED=0
else
  PASEO_HOME="$DEV_STATE_DIR/paseo-home"
  PASEO_HOME_MANAGED=1
fi
export PASEO_HOME
export PASEO_ELECTRON_USER_DATA_DIR="${PASEO_ELECTRON_USER_DATA_DIR:-$DEV_STATE_DIR/user-data}"
mkdir -p "$PASEO_HOME" "$PASEO_ELECTRON_USER_DATA_DIR"

DEV_DAEMON_PORT="${PASEO_DEV_DAEMON_PORT:-6788}"
export PASEO_LISTEN="${PASEO_LISTEN:-127.0.0.1:$DEV_DAEMON_PORT}"

# Seed the isolated daemon config. The desktop daemon-manager decides whether a
# daemon is already running by reading `daemon.listen` from this config.json
# (it does NOT honor the PASEO_LISTEN env var) and probing that address. Without
# this it reads the default 6767, finds a production daemon there, and connects
# the dev app to prod — whose CORS allowlist then rejects the Metro origin. Pin
# the dev port + wildcard CORS in the file so the dev app starts its OWN daemon.
# ONLY seed the script-managed home: never rewrite a user-supplied PASEO_HOME
# (that could clobber a production config.json with the dev port + wildcard CORS).
if [ "$PASEO_HOME_MANAGED" = "1" ]; then
  node -e '
const fs = require("fs");
const [path, port] = [process.argv[1], process.argv[2]];
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
cfg.version = cfg.version || 1;
cfg.daemon = cfg.daemon || {};
cfg.daemon.listen = `127.0.0.1:${port}`;
cfg.daemon.cors = cfg.daemon.cors || {};
cfg.daemon.cors.allowedOrigins = ["*"];
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
' "$PASEO_HOME/config.json" "$DEV_DAEMON_PORT"
else
  echo "  (custom PASEO_HOME — leaving its config.json untouched)"
fi

echo "══════════════════════════════════════════════════════"
echo "  Paseo Desktop Dev"
echo "══════════════════════════════════════════════════════"
echo "  Metro:      http://localhost:${EXPO_PORT}"
echo "  CDP:        http://127.0.0.1:${REMOTE_DEBUGGING_PORT}"
echo "  Daemon:     ${PASEO_LISTEN} (isolated)"
echo "  PASEO_HOME: ${PASEO_HOME}"
echo "  userData:   ${PASEO_ELECTRON_USER_DATA_DIR}"
echo "══════════════════════════════════════════════════════"

# Launch Metro + Electron together, kill both on exit
exec "$ROOT_DIR/node_modules/.bin/concurrently" \
  --kill-others \
  --names "metro,electron" \
  --prefix-colors "magenta,cyan" \
  "cd '$APP_DIR' && PASEO_WEB_PLATFORM=electron npx expo start --port $EXPO_PORT" \
  "$ROOT_DIR/node_modules/.bin/wait-on tcp:$EXPO_PORT && EXPO_DEV_URL=http://localhost:$EXPO_PORT electron '$DESKTOP_DIR'"
