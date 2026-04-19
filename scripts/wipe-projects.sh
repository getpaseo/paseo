#!/bin/bash
# wipe-projects.sh — Nuke all local projects + (optionally) online registry.
# Safe: exits non-zero on unexpected state instead of silently wiping the wrong dir.
set -u

HUBCODE_HOME="${HUBCODE_HOME:-$HOME/.hubcode}"

if [ ! -d "$HUBCODE_HOME" ]; then
  echo "error: $HUBCODE_HOME does not exist — nothing to wipe"
  exit 1
fi

echo "wiping $HUBCODE_HOME/projects ..."

# ── Kill the daemon if it's running ────────────────────────────────────────
PID_FILE="$HUBCODE_HOME/hubcode.pid"
if [ -f "$PID_FILE" ]; then
  DAEMON_PID=$(python3 -c "import sys,json; print(json.load(sys.stdin).get('pid',''))" <"$PID_FILE" 2>/dev/null || true)
  if [ -n "${DAEMON_PID:-}" ]; then
    echo "  killing daemon pid=$DAEMON_PID"
    kill -9 "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi

# ── Reset the project + workspace registries ──────────────────────────────
mkdir -p "$HUBCODE_HOME/projects"
echo "[]" >"$HUBCODE_HOME/projects/projects.json"
echo "[]" >"$HUBCODE_HOME/projects/workspaces.json"
echo "  ✓ local registries cleared"

# ── Optionally clear the online project_registry table ────────────────────
if [ -n "${DATABASE_URL:-}" ] && command -v psql >/dev/null 2>&1; then
  psql "$DATABASE_URL" -c "DELETE FROM project_registry;" >/dev/null 2>&1 \
    && echo "  ✓ online project_registry cleared" \
    || echo "  ⚠ online wipe failed (check DATABASE_URL)"
else
  echo "  ⸺ skipping online wipe (set DATABASE_URL + install psql to enable)"
fi

echo
echo "done. restart \`bash packages/desktop/scripts/dev.sh\` to respawn a clean daemon."
