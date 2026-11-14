#!/usr/bin/env bash

default_dev_paseo_root() {
  git rev-parse --show-toplevel 2>/dev/null || pwd
}

seed_worktree_paseo_home() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  node "$script_dir/seed-dev-home.mjs" "${PASEO_DEV_SEED_HOME:-$HOME/.paseo}" "$1"
}

configure_dev_daemon_config() {
  if [ -z "${PASEO_LISTEN:-}" ]; then
    return
  fi

  mkdir -p "$PASEO_HOME"
  node -e '
const fs = require("fs");
const [path, listen] = [process.argv[1], process.argv[2]];
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
cfg.version = cfg.version || 1;
cfg.daemon = cfg.daemon || {};
cfg.daemon.listen = listen;
cfg.daemon.cors = cfg.daemon.cors || {};
cfg.daemon.cors.allowedOrigins = ["*"];
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
' "$PASEO_HOME/config.json" "$PASEO_LISTEN"
}

resolve_dev_daemon_endpoint() {
  if [ -n "${PASEO_DEV_DAEMON_ENDPOINT:-}" ]; then
    echo "$PASEO_DEV_DAEMON_ENDPOINT"
    return
  fi

  case "${PASEO_LISTEN:-127.0.0.1:6768}" in
    0.0.0.0:*) echo "localhost:${PASEO_LISTEN#0.0.0.0:}" ;;
    127.0.0.1:*) echo "localhost:${PASEO_LISTEN#127.0.0.1:}" ;;
    *) echo "$PASEO_LISTEN" ;;
  esac
}

configure_dev_paseo_home() {
  if [ -n "${PASEO_HOME:-}" ]; then
    export PASEO_HOME
    if [ -n "${PASEO_DEV_SEED_HOME:-}" ]; then
      seed_worktree_paseo_home "$PASEO_HOME"
    fi
    mkdir -p "$PASEO_HOME"
    if [ "${PASEO_DEV_MANAGED_HOME:-0}" = "1" ] || [ -n "${PASEO_DEV_SEED_HOME:-}" ]; then
      configure_dev_daemon_config
    fi
    return
  fi

  export PASEO_HOME
  local dev_root
  dev_root="${PASEO_DEV_ROOT:-$(default_dev_paseo_root)}"
  PASEO_HOME="$dev_root/.dev/paseo-home"
  export PASEO_DEV_MANAGED_HOME=1

  if [ -n "${PASEO_DEV_SEED_HOME:-}" ]; then
    seed_worktree_paseo_home "$PASEO_HOME"
  fi

  mkdir -p "$PASEO_HOME"
  configure_dev_daemon_config
}

configure_dev_command_env() {
  if [ -z "${PASEO_LISTEN:-}" ]; then
    if [ -n "${PASEO_SERVICE_DAEMON_PORT:-}" ]; then
      export PASEO_LISTEN="0.0.0.0:${PASEO_SERVICE_DAEMON_PORT}"
    else
      export PASEO_LISTEN="127.0.0.1:6768"
    fi
  fi

  configure_dev_paseo_home
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ "$#" -gt 0 ]; then
    configure_dev_command_env
    exec "$@"
  fi

  configure_dev_paseo_home
fi
