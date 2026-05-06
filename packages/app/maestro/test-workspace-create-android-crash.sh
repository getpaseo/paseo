#!/usr/bin/env bash
# Android Maestro harness for the workspace-creation redirect crash.
#
# Starts from a clean app state, connects the Android app to the local daemon,
# opens a prepared git project, creates a workspace through the UI, and captures
# adb logcat around the redirect window.
#
# This harness is deliberately stronger than "composer is visible": it selects
# a model, taps Create, asserts the workspace header, asserts the New Workspace
# route is gone, and fails if logcat contains the Android Fabric view-parent
# crash signature.
#
# Usage:
#   bash packages/app/maestro/test-workspace-create-android-crash.sh
#
# Optional environment:
#   PASEO_MAESTRO_APP_ID=sh.paseo.debug
#   PASEO_MAESTRO_DIRECT_ENDPOINT=127.0.0.1:6767
#   PASEO_MAESTRO_DAEMON_WS_URL=ws://127.0.0.1:6767/ws
#   PASEO_MAESTRO_PROJECT_PATH=/path/to/git/repo
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
FLOW_TEMPLATE="$REPO_ROOT/packages/app/maestro/workspace-create-android-crash.yaml"
FLOW_TEMPLATE_DIR="$REPO_ROOT/packages/app/maestro"
OUT_DIR="/tmp/paseo-workspace-create-android-$(date +%s)"
SERVER_EXPORTS="$REPO_ROOT/packages/server/dist/server/server/exports.js"

export PASEO_MAESTRO_APP_ID="${PASEO_MAESTRO_APP_ID:-sh.paseo.debug}"
export PASEO_MAESTRO_DIRECT_ENDPOINT="${PASEO_MAESTRO_DIRECT_ENDPOINT:-127.0.0.1:6767}"
export PASEO_MAESTRO_DAEMON_WS_URL="${PASEO_MAESTRO_DAEMON_WS_URL:-ws://127.0.0.1:6767/ws}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command adb
require_command git
require_command maestro
require_command node
require_command perl

render_flow() {
  local source="$1"
  local target="$2"
  mkdir -p "$(dirname "$target")"
  perl -0pe '
    s/\$\{PASEO_MAESTRO_APP_ID\}/$ENV{PASEO_MAESTRO_APP_ID}/g;
    s/\$\{PASEO_MAESTRO_DIRECT_ENDPOINT\}/$ENV{PASEO_MAESTRO_DIRECT_ENDPOINT}/g;
    s/\$\{PASEO_MAESTRO_PROJECT_NAME\}/$ENV{PASEO_MAESTRO_PROJECT_NAME}/g;
  ' "$source" > "$target"
}

render_flow_tree() {
  mkdir -p "$OUT_DIR/flows"
  render_flow "$FLOW_TEMPLATE" "$FLOW"
  for source in "$FLOW_TEMPLATE_DIR"/flows/*.yaml; do
    render_flow "$source" "$OUT_DIR/flows/$(basename "$source")"
  done
}

if [ ! -f "$SERVER_EXPORTS" ]; then
  echo "Missing server build artifact: $SERVER_EXPORTS" >&2
  echo "Run: npm run build --workspace=@getpaseo/server" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

if [ -z "${PASEO_MAESTRO_PROJECT_PATH:-}" ]; then
  PROJECT_PARENT="$(mktemp -d /tmp/paseo-maestro-project-XXXXXX)"
  PROJECT_BASENAME="aaa-workspace-create-android-$(basename "$PROJECT_PARENT")"
  export PASEO_MAESTRO_PROJECT_PATH="$PROJECT_PARENT/$PROJECT_BASENAME"
  mkdir -p "$PASEO_MAESTRO_PROJECT_PATH"
  git -C "$PASEO_MAESTRO_PROJECT_PATH" init >/dev/null
  git -C "$PASEO_MAESTRO_PROJECT_PATH" checkout -b main >/dev/null 2>&1 || true
  git -C "$PASEO_MAESTRO_PROJECT_PATH" config user.name "Paseo Maestro"
  git -C "$PASEO_MAESTRO_PROJECT_PATH" config user.email "maestro@getpaseo.local"
  printf "# Workspace create Android repro\n" > "$PASEO_MAESTRO_PROJECT_PATH/README.md"
  git -C "$PASEO_MAESTRO_PROJECT_PATH" add README.md
  git -C "$PASEO_MAESTRO_PROJECT_PATH" commit -m "Initial commit" >/dev/null
else
  PROJECT_PARENT=""
fi

export PASEO_MAESTRO_PROJECT_NAME="${PASEO_MAESTRO_PROJECT_NAME:-$(basename "$PASEO_MAESTRO_PROJECT_PATH")}"

echo "=== Workspace Create Android Crash Harness ==="
echo "Output dir: $OUT_DIR"
echo "App id: $PASEO_MAESTRO_APP_ID"
echo "Android direct endpoint: $PASEO_MAESTRO_DIRECT_ENDPOINT"
echo "Daemon websocket: $PASEO_MAESTRO_DAEMON_WS_URL"
echo "Project: $PASEO_MAESTRO_PROJECT_PATH"
echo "Project name: $PASEO_MAESTRO_PROJECT_NAME"

FLOW="$OUT_DIR/workspace-create-android-crash.rendered.yaml"
render_flow_tree
echo "Rendered flow: $FLOW"

echo ""
echo "Preparing Android port reverse..."
adb reverse tcp:6767 tcp:6767 >/dev/null

echo ""
echo "Opening project in daemon..."
REPO_ROOT="$REPO_ROOT" node --input-type=module <<'NODE'
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

const repoRoot = process.env.REPO_ROOT;
const projectPath = process.env.PASEO_MAESTRO_PROJECT_PATH;
const daemonUrl = process.env.PASEO_MAESTRO_DAEMON_WS_URL;
if (!repoRoot || !projectPath || !daemonUrl) {
  throw new Error("Missing required environment for daemon project setup.");
}

const moduleUrl = pathToFileURL(`${repoRoot}/packages/server/dist/server/server/exports.js`).href;
const { DaemonClient } = await import(moduleUrl);
const client = new DaemonClient({
  url: daemonUrl,
  clientId: `maestro-workspace-create-${Date.now()}`,
  clientType: "cli",
  webSocketFactory: (url, options) => new WebSocket(url, { headers: options?.headers }),
});

try {
  await client.connect();
  const payload = await client.openProject(projectPath);
  if (payload.error || !payload.workspace) {
    throw new Error(payload.error ?? "openProject returned no workspace");
  }
  console.log(
    JSON.stringify({
      workspaceId: payload.workspace.id,
      projectId: payload.workspace.projectId,
      projectDisplayName: payload.workspace.projectDisplayName,
    }),
  );
} finally {
  await client.close().catch(() => undefined);
}
NODE

LOGCAT_PID=""
cleanup() {
  if [ -n "$LOGCAT_PID" ]; then
    kill "$LOGCAT_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo ""
echo "Capturing Android logcat..."
adb logcat -c || true
adb logcat -v time > "$OUT_DIR/logcat.txt" &
LOGCAT_PID="$!"

echo "Running Maestro flow..."
set +e
(cd "$OUT_DIR" && maestro test "$FLOW") 2>&1 | tee "$OUT_DIR/maestro.log"
MAESTRO_STATUS=${PIPESTATUS[0]}
set -e

cleanup
LOGCAT_PID=""

if [ "$MAESTRO_STATUS" -ne 0 ]; then
  adb exec-out screencap -p > "$OUT_DIR/failure-state.png" 2>/dev/null || true
  echo ""
  echo "Maestro failed. Artifacts: $OUT_DIR" >&2
  exit "$MAESTRO_STATUS"
fi

if grep -E "failed to insert view|specified child already has a parent" "$OUT_DIR/logcat.txt" >/dev/null; then
  adb exec-out screencap -p > "$OUT_DIR/failure-state.png" 2>/dev/null || true
  echo ""
  echo "Android native view crash signature found in logcat. Artifacts: $OUT_DIR" >&2
  grep -n -E "failed to insert view|specified child already has a parent" "$OUT_DIR/logcat.txt" >&2 || true
  exit 1
fi

echo ""
echo "PASS: workspace creation flow completed without the Android view-parent crash signature."
echo "Artifacts: $OUT_DIR"
