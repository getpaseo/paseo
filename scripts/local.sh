#!/bin/bash
# local.sh — manual dev startup for Junction
#
# Usage: npm run local
#
# Runs setup (DB, env, builds) then starts all 3 services with concurrently.
# Handles port conflicts gracefully — shows what's using the port and offers
# to kill it before proceeding.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export PATH="$REPO_ROOT/node_modules/.bin:$PATH"

# ------------------------------------------------------------------
# Port configuration (override via env vars)
# ------------------------------------------------------------------
export DAEMON_PORT="${DAEMON_PORT:-6767}"
export API_PORT="${API_PORT:-3100}"
export APP_PORT="${APP_PORT:-5173}"
export WORKSPACE_NAME="${WORKSPACE_NAME:-junction_local}"
export JUNCTION_HOME="${JUNCTION_HOME:-$HOME/.junction}"

# ------------------------------------------------------------------
# Graceful port conflict handling
# ------------------------------------------------------------------
check_port() {
  local port="$1"
  local service="$2"
  local pid

  pid="$(lsof -ti :"$port" 2>/dev/null | head -1)" || true

  if [ -n "$pid" ]; then
    local proc_name
    proc_name="$(ps -p "$pid" -o comm= 2>/dev/null || echo "unknown")"

    echo ""
    echo "⚠  Port ${port} (${service}) is in use by PID ${pid} (${proc_name})"
    echo ""

    # In non-interactive mode (e.g. Conductor), just pick next available port
    if [ ! -t 0 ]; then
      echo "   Non-interactive mode — finding next available port..."
      local new_port
      new_port="$(get-port "$port" "$((port+1))" "$((port+2))" "$((port+3))" "$((port+4))" "$((port+5))" 2>/dev/null || echo "")"
      if [ -n "$new_port" ]; then
        echo "   Using port ${new_port} instead."
        eval "export ${service}_PORT_OVERRIDE=${new_port}"
        return 0
      else
        echo "   ERROR: Could not find an available port near ${port}."
        exit 1
      fi
    fi

    # Interactive mode — ask user
    echo "   [k] Kill process ${pid} gracefully and use port ${port}"
    echo "   [n] Find next available port"
    echo "   [q] Quit"
    echo ""
    read -r -p "   Choice [k/n/q]: " choice

    case "$choice" in
      k|K)
        echo "   Sending SIGTERM to ${pid}..."
        kill "$pid" 2>/dev/null || true
        # Wait up to 5 seconds for graceful shutdown
        for i in $(seq 1 10); do
          if ! kill -0 "$pid" 2>/dev/null; then
            echo "   Process ${pid} terminated."
            return 0
          fi
          sleep 0.5
        done
        echo "   Process didn't stop — sending SIGKILL..."
        kill -9 "$pid" 2>/dev/null || true
        sleep 0.5
        echo "   Process ${pid} force-killed."
        ;;
      n|N)
        local new_port
        new_port="$(get-port "$port" "$((port+1))" "$((port+2))" "$((port+3))" "$((port+4))" "$((port+5))" 2>/dev/null || echo "")"
        if [ -n "$new_port" ]; then
          echo "   Using port ${new_port} instead."
          # Update the exported variable
          case "$service" in
            daemon) export DAEMON_PORT="$new_port" ;;
            api)    export API_PORT="$new_port" ;;
            app)    export APP_PORT="$new_port" ;;
          esac
        else
          echo "   ERROR: Could not find an available port near ${port}."
          exit 1
        fi
        ;;
      q|Q)
        echo "   Aborted."
        exit 0
        ;;
      *)
        echo "   Invalid choice. Aborting."
        exit 1
        ;;
    esac
  fi
}

# Check all service ports for conflicts
check_port "$DAEMON_PORT" "daemon"
check_port "$API_PORT" "api"
check_port "$APP_PORT" "app"

# ------------------------------------------------------------------
# Run setup (DB, env files, builds)
# ------------------------------------------------------------------
source "$SCRIPT_DIR/setup-common.sh"

# ------------------------------------------------------------------
# Build CORS and connection strings for the running services
# ------------------------------------------------------------------
CORS_ORIGINS="http://localhost:${APP_PORT},http://127.0.0.1:${APP_PORT}"
LOCAL_DAEMON="localhost:${DAEMON_PORT}"

echo ""
echo "══════════════════════════════════════════════════════"
echo "  Starting Junction Dev"
echo "══════════════════════════════════════════════════════"
echo "  Daemon:  http://localhost:${DAEMON_PORT}"
echo "  API:     http://localhost:${API_PORT}"
echo "  App:     http://localhost:${APP_PORT}"
echo "══════════════════════════════════════════════════════"
echo ""

# ------------------------------------------------------------------
# Start all services with concurrently (TUI-style)
# ------------------------------------------------------------------
exec concurrently \
  --names "daemon,api,app" \
  --prefix-colors "cyan,yellow,magenta" \
  --prefix "[{name}]" \
  --kill-others-on-fail \
  --handle-input \
  "JUNCTION_LISTEN=0.0.0.0:${DAEMON_PORT} JUNCTION_CORS_ORIGINS='${CORS_ORIGINS}' JUNCTION_HOME='${JUNCTION_HOME}' npm run dev:server" \
  "PORT=${API_PORT} DATABASE_URL='postgresql://postgres:postgres@localhost:5435/${WORKSPACE_NAME}' CORS_ORIGINS='${CORS_ORIGINS}' npm run dev:api" \
  "BROWSER=none VITE_API_URL='http://localhost:${API_PORT}' EXPO_PUBLIC_LOCAL_DAEMON='${LOCAL_DAEMON}' npx vite --port ${APP_PORT} --host --config packages/app/vite.config.ts"
