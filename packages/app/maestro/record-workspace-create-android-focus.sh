#!/usr/bin/env bash
# Records only the Android workspace-creation repro window.
#
# The setup Maestro flow gets the app to the open sidebar with a prepared
# project visible. Recording starts after that, then the focused flow taps the
# new-workspace button, selects a provider/model, taps Create, and asserts the
# app lands on the created workspace rather than remaining on /new.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
FLOW_TEMPLATE_DIR="$REPO_ROOT/packages/app/maestro"
SETUP_TEMPLATE="$REPO_ROOT/packages/app/maestro/workspace-create-android-ready-sidebar.yaml"
FOCUS_TEMPLATE="$REPO_ROOT/packages/app/maestro/workspace-create-android-create-focused.yaml"
OUT_DIR="/tmp/paseo-workspace-create-android-focus-$(date +%s)"
VIDEO_DIR="/tmp/paseo-maestro-videos"
DEVICE_VIDEO="/sdcard/paseo-maestro-workspace-create-focused.mp4"
LOCAL_VIDEO="$VIDEO_DIR/paseo-maestro-workspace-create-focused.mp4"

export PASEO_MAESTRO_APP_ID="${PASEO_MAESTRO_APP_ID:-sh.paseo.debug}"
export PASEO_MAESTRO_DIRECT_ENDPOINT="${PASEO_MAESTRO_DIRECT_ENDPOINT:-127.0.0.1:6767}"
export PASEO_MAESTRO_DAEMON_WS_URL="${PASEO_MAESTRO_DAEMON_WS_URL:-ws://127.0.0.1:6767/ws}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

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
  render_flow "$SETUP_TEMPLATE" "$SETUP_FLOW"
  render_flow "$FOCUS_TEMPLATE" "$FOCUS_FLOW"
  for source in "$FLOW_TEMPLATE_DIR"/flows/*.yaml; do
    render_flow "$source" "$OUT_DIR/flows/$(basename "$source")"
  done
}

require_command adb
require_command git
require_command maestro
require_command node
require_command perl

mkdir -p "$OUT_DIR" "$VIDEO_DIR"

if [ -z "${PASEO_MAESTRO_PROJECT_PATH:-}" ]; then
  PROJECT_PARENT="$(mktemp -d /tmp/paseo-maestro-project-XXXXXX)"
  PROJECT_BASENAME="aaa-workspace-create-android-$(basename "$PROJECT_PARENT")"
  export PASEO_MAESTRO_PROJECT_PATH="$PROJECT_PARENT/$PROJECT_BASENAME"
  mkdir -p "$PASEO_MAESTRO_PROJECT_PATH"
  git -C "$PASEO_MAESTRO_PROJECT_PATH" init >/dev/null
  git -C "$PASEO_MAESTRO_PROJECT_PATH" checkout -b main >/dev/null 2>&1 || true
  git -C "$PASEO_MAESTRO_PROJECT_PATH" config user.name "Paseo Maestro"
  git -C "$PASEO_MAESTRO_PROJECT_PATH" config user.email "maestro@getpaseo.local"
  printf "# Workspace create Android focused recording\n" > "$PASEO_MAESTRO_PROJECT_PATH/README.md"
  git -C "$PASEO_MAESTRO_PROJECT_PATH" add README.md
  git -C "$PASEO_MAESTRO_PROJECT_PATH" commit -m "Initial commit" >/dev/null
fi

export PASEO_MAESTRO_PROJECT_NAME="${PASEO_MAESTRO_PROJECT_NAME:-$(basename "$PASEO_MAESTRO_PROJECT_PATH")}"

SETUP_FLOW="$OUT_DIR/workspace-create-android-ready-sidebar.rendered.yaml"
FOCUS_FLOW="$OUT_DIR/workspace-create-android-create-focused.rendered.yaml"
render_flow_tree

echo "=== Focused Android Workspace Create Recording ==="
echo "Output dir: $OUT_DIR"
echo "Video: $LOCAL_VIDEO"
echo "Project: $PASEO_MAESTRO_PROJECT_PATH"
echo "Project name: $PASEO_MAESTRO_PROJECT_NAME"

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
  clientId: `maestro-workspace-create-focus-${Date.now()}`,
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
      projectDisplayName: payload.workspace.projectDisplayName,
    }),
  );
} finally {
  await client.close().catch(() => undefined);
}
NODE

echo ""
echo "Staging app at open sidebar..."
(cd "$OUT_DIR" && maestro test "$SETUP_FLOW") 2>&1 | tee "$OUT_DIR/setup.log"

echo ""
echo "Recording focused create flow..."
adb shell rm -f "$DEVICE_VIDEO" >/dev/null 2>&1 || true
adb shell screenrecord --time-limit 90 "$DEVICE_VIDEO" &
SCREENRECORD_PID=$!
sleep 1

set +e
(cd "$OUT_DIR" && maestro test "$FOCUS_FLOW") 2>&1 | tee "$OUT_DIR/focus.log"
FOCUS_STATUS=${PIPESTATUS[0]}
set -e

kill -INT "$SCREENRECORD_PID" >/dev/null 2>&1 || true
wait "$SCREENRECORD_PID" >/dev/null 2>&1 || true
adb shell pkill -INT screenrecord >/dev/null 2>&1 || true

adb pull "$DEVICE_VIDEO" "$LOCAL_VIDEO" >/dev/null
ls -lh "$LOCAL_VIDEO"

if [ "$FOCUS_STATUS" -ne 0 ]; then
  echo "Focused Maestro flow failed. Artifacts: $OUT_DIR" >&2
  exit "$FOCUS_STATUS"
fi

echo "Focused recording complete."
echo "Artifacts: $OUT_DIR"
