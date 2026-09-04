#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_HOME="$ROOT_DIR/.dev/herdr-pi-live-smoke-home"
DEFAULT_SESSION="paseo-herdr-live-smoke"
DEFAULT_LISTEN="127.0.0.1:6768"

usage() {
  cat <<'EOF'
Usage:
  scripts/herdr-pi-live-smoke.sh prepare [--home PATH] [--herdr-session NAME] [--listen HOST:PORT]
  scripts/herdr-pi-live-smoke.sh dev-server [--home PATH] [--herdr-session NAME] [--listen HOST:PORT]
  scripts/herdr-pi-live-smoke.sh pair [--home PATH] [--herdr-session NAME] [--listen HOST:PORT] [--relay]

Prepare a disposable Paseo home for the Herdr-attached Pi live smoke.
The helper only writes Paseo config and optionally starts/pairs the dev daemon.
It does not start, stop, delete, restart, profile, or otherwise drive Herdr.

Defaults:
  --home           .dev/herdr-pi-live-smoke-home
  --herdr-session paseo-herdr-live-smoke
  --listen         127.0.0.1:6768
EOF
}

command="${1:-prepare}"
case "$command" in
  prepare|dev-server|pair) shift || true ;;
  -h|--help|help) usage; exit 0 ;;
  *) echo "Unknown command: $command" >&2; usage >&2; exit 2 ;;
esac

home="$DEFAULT_HOME"
herdr_session="$DEFAULT_SESSION"
listen="$DEFAULT_LISTEN"
pair_relay=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --home)
      home="${2:?--home requires a path}"
      shift 2
      ;;
    --herdr-session)
      herdr_session="${2:?--herdr-session requires a name}"
      shift 2
      ;;
    --listen)
      listen="${2:?--listen requires HOST:PORT}"
      shift 2
      ;;
    --relay)
      pair_relay=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

canonicalize_path() {
  node - "$1" <<'NODE'
const fs = require("fs");
const path = require("path");
let ancestor = path.resolve(process.argv[2]);
const suffix = [];
while (!fs.existsSync(ancestor)) {
  suffix.unshift(path.basename(ancestor));
  ancestor = path.dirname(ancestor);
}
console.log(path.join(fs.realpathSync(ancestor), ...suffix));
NODE
}

home="$(canonicalize_path "$home")"
normal_home="$(canonicalize_path "$HOME/.paseo")"

if [ "$home" = "$normal_home" ]; then
  echo "Refusing to use the normal Paseo home: $home" >&2
  echo "Choose a disposable --home path for the live smoke." >&2
  exit 1
fi

write_config() {
  mkdir -p "$home"
  node - "$home/config.json" "$herdr_session" "$listen" <<'NODE'
const fs = require("fs");
const [configPath, herdrSession, listen] = process.argv.slice(2);
const disabledProvider = { enabled: false };
const config = {
  version: 1,
  daemon: {
    listen,
    cors: { allowedOrigins: ["*"] },
    relay: { enabled: false },
  },
  agents: {
    providers: {
      pi: {
        enabled: true,
        params: {
          herdr: {
            enabled: true,
            session: herdrSession,
          },
        },
      },
      claude: disabledProvider,
      codex: disabledProvider,
      copilot: disabledProvider,
      opencode: disabledProvider,
      omp: disabledProvider,
      mock: disabledProvider,
      "mock-slow": disabledProvider,
    },
  },
};
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
NODE
}

write_config

export PASEO_HOME="$home"
export PASEO_LISTEN="$listen"
export PASEO_DEV_MANAGED_HOME=1
export PASEO_DEV_SEED_HOME=

case "$command" in
  prepare)
    cat <<EOF
Prepared Herdr-attached Pi live-smoke home.

PASEO_HOME=$PASEO_HOME
PASEO_LISTEN=$PASEO_LISTEN
Herdr session=$herdr_session
Config=$PASEO_HOME/config.json

Next commands:
  scripts/herdr-pi-live-smoke.sh dev-server --home '$PASEO_HOME' --herdr-session '$herdr_session' --listen '$PASEO_LISTEN'
  scripts/herdr-pi-live-smoke.sh pair --home '$PASEO_HOME' --herdr-session '$herdr_session' --listen '$PASEO_LISTEN' --relay

Start a disposable Pi target in the named Herdr session yourself before importing it in Paseo.
Do not import or prompt a real Firstmate/Pi session.
EOF
    ;;
  dev-server)
    exec "$SCRIPT_DIR/dev-daemon.sh"
    ;;
  pair)
    if [ "$pair_relay" = "1" ]; then
      exec npm run cli -- daemon pair --home "$PASEO_HOME" --relay
    fi
    exec npm run cli -- daemon pair --home "$PASEO_HOME"
    ;;
esac
