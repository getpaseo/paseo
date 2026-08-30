#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
STATE_DIR="${PASEO_COMPOSER_KEYBOARD_STATE_DIR:-${REPO_ROOT}/.dev/agent-device-composer-keyboard}"
ARTIFACTS_DIR="${REPO_ROOT}/.dev/agent-device-artifacts/composer-keyboard-android"
SESSION="${PASEO_COMPOSER_KEYBOARD_SESSION:-composer-keyboard-android}"
APP_ID="${PASEO_COMPOSER_KEYBOARD_APP_ID:-sh.paseo.debug}"
DEVICE="${PASEO_COMPOSER_KEYBOARD_DEVICE:-paseo-api35}"
HELPER_IME="com.callstack.agentdevice.imehelper/.TestInputMethodService"
GBOARD_IME="com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME"
ASSERT="${REPO_ROOT}/packages/app/e2e/mobile/composer-keyboard/assert-composer-keyboard.mjs"
STALL_HERMES="${REPO_ROOT}/packages/app/e2e/mobile/composer-keyboard/stall-hermes.mjs"
METRO_PORT="${PASEO_MOBILE_E2E_METRO_PORT:-8082}"
DAEMON_HOST="${PASEO_COMPOSER_KEYBOARD_DAEMON_HOST:-127.0.0.1:6770}"
DAEMON_HOME="${PASEO_COMPOSER_KEYBOARD_DAEMON_HOME:-${REPO_ROOT}/.dev/composer-e2e-home}"
SERVER_ID="${PASEO_COMPOSER_KEYBOARD_SERVER_ID:-}"
MESSAGE=$'keyboard invariant line one\nline two\nline three\nline four'
LONG_MESSAGE="$(node -e 'process.stdout.write(Array.from({ length: 180 }, (_, index) => `line${index + 1}`).join(" "))')"
AGENT_TITLE="Keyboard dismiss QA $(date +%s)"

if [[ -z "${SERVER_ID}" ]]; then
  if [[ ! -f "${DAEMON_HOME}/server-id" ]]; then
    echo "Missing ${DAEMON_HOME}/server-id; set PASEO_COMPOSER_KEYBOARD_SERVER_ID" >&2
    exit 1
  fi
  SERVER_ID="$(<"${DAEMON_HOME}/server-id")"
fi

ad() {
  AGENT_DEVICE_STATE_DIR="${STATE_DIR}" agent-device "$@" --session "${SESSION}"
}

capture_screen() {
  local output_path="$1"
  ad screenshot "${output_path}" >/dev/null
}

snapshot_json() {
  local output_path="$1"
  ad snapshot -i --json >"${output_path}"
}

capture_ui_xml() {
  local output_path="$1"
  local device_path="/sdcard/paseo-composer-keyboard-window.xml"
  # Android exposes one UI Automation connection at a time. Release the
  # persistent agent-device snapshot helper before asking uiautomator for the
  # app and IME windows; agent-device reconnects it on the next interaction.
  adb shell am force-stop com.callstack.agentdevice.snapshothelper
  sleep 0.2
  adb shell uiautomator dump "${device_path}" >/dev/null
  adb pull "${device_path}" "${output_path}" >/dev/null
}

clear_input() {
  ad fill 'editable=true' "x" --settle
  adb shell input keycombination 113 29
  adb shell input keyevent 67
}

clear_focused_input_with_adb() {
  adb shell input keycombination 113 29
  adb shell input keyevent 67
}

wait_for_ime() {
  local expected="$1"
  local previous_top=""
  local stable_count=0
  for _ in $(seq 1 30); do
    local window_state
    window_state="$(adb shell dumpsys window)"
    if [[ "${expected}" == "true" ]]; then
      local ime_top
      ime_top="$(printf '%s' "${window_state}" | sed -n 's/.*type=ime frame=\[0,\([0-9][0-9]*\)\].*visible=true.*/\1/p' | head -1)"
      if [[ -n "${ime_top}" && "${ime_top}" -gt 0 ]]; then
        if [[ "${ime_top}" == "${previous_top}" ]]; then
          stable_count="$((stable_count + 1))"
        else
          stable_count=0
          previous_top="${ime_top}"
        fi
        if [[ "${stable_count}" -ge 2 ]]; then
          return
        fi
      fi
    elif ! printf '%s' "${window_state}" | rg -q "type=ime .*visible=true"; then
      return
    fi
    sleep 0.1
  done
  echo "IME did not become visible=${expected}" >&2
  exit 1
}

ime_is_visible() {
  adb shell dumpsys window | rg -q "type=ime .*visible=true"
}

open_gboard() {
  local x="$1"
  local y="$2"
  adb shell ime set "${GBOARD_IME}" >/dev/null
  if ime_is_visible; then
    adb shell input keyevent BACK
    wait_for_ime false
  fi
  adb shell input tap "${x}" "${y}"
  wait_for_ime true
  local keyboard_shift
  keyboard_shift="$(read_keyboard_shift)"
  adb shell input tap "${x}" "$((y - keyboard_shift))"
}

read_keyboard_shift() {
  local ime_top
  local navigation_top
  ime_top="$(adb shell dumpsys window | sed -n 's/.*type=ime frame=\[0,\([0-9][0-9]*\)\].*visible=true.*/\1/p' | head -1)"
  navigation_top="$(adb shell dumpsys window | sed -n 's/.*type=navigationBars frame=\[0,\([0-9][0-9]*\)\].*/\1/p' | head -1)"
  printf '%s\n' "$((navigation_top - ime_top))"
}

read_ime_top() {
  adb shell dumpsys window | sed -n \
    's/.*type=ime frame=\[0,\([0-9][0-9]*\)\].*visible=true.*/\1/p' | head -1
}

cleanup() {
  adb shell ime set "${HELPER_IME}" >/dev/null 2>&1 || true
  AGENT_DEVICE_STATE_DIR="${STATE_DIR}" agent-device daemon stop --clean >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM
cleanup
mkdir -p "${STATE_DIR}" "${ARTIFACTS_DIR}"

workspaces_json="$(env -u PASEO_CALLER_AGENT_ID -u PASEO_AGENT_ID -u PASEO_WORKSPACE_ID \
  npm run --silent cli -- workspace ls --json --host "${DAEMON_HOST}")"
workspace_id="$(node -e '
  const workspaces = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  const cwd = process.argv[1];
  const workspace = workspaces.find((candidate) => candidate.cwd === cwd);
  if (!workspace) process.exit(1);
  process.stdout.write(workspace.workspaceId);
' "${REPO_ROOT}" <<<"${workspaces_json}")"

AGENT_DEVICE_STATE_DIR="${STATE_DIR}" agent-device open "${APP_ID}" \
  --platform android \
  --device "${DEVICE}" \
  --session "${SESSION}"
adb shell am force-stop "${APP_ID}"
adb shell am start \
  -a android.intent.action.VIEW \
  -d "exp+voice-mobile://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A${METRO_PORT}" \
  "${APP_ID}" >/dev/null
sleep 3

# Create the fixture while the client is connected so its directory replica observes the insert.
run_json="$(env -u PASEO_CALLER_AGENT_ID -u PASEO_AGENT_ID -u PASEO_WORKSPACE_ID \
  npm run --silent cli -- run "Exercise the composer keyboard invariant flow" \
  --background \
  --title "${AGENT_TITLE}" \
  --provider mock \
  --model e2e-fast-stream \
  --workspace "${workspace_id}" \
  --cwd "${REPO_ROOT}" \
  --host "${DAEMON_HOST}" \
  --json)"
agent_id="$(node -e '
  const result = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  process.stdout.write(result.agentId);
' <<<"${run_json}")"
sleep 3

adb shell am start \
  -a android.intent.action.VIEW \
  -d "paseo://h/${SERVER_ID}/agent/${agent_id}" \
  "${APP_ID}" >/dev/null
sleep 5
# The development-client bootstrap can consume the first link while Expo Router is mounting.
# Deliver the target again after the root navigator is live.
adb shell am start \
  -a android.intent.action.VIEW \
  -d "paseo://h/${SERVER_ID}/agent/${agent_id}" \
  "${APP_ID}" >/dev/null
ad wait "text=\"${AGENT_TITLE}\"" 45000
ad wait 'editable=true' 10000
clear_input
ad keyboard dismiss || true
ad wait 'label="Message, @files, /commands"' 10000

snapshot_json "${ARTIFACTS_DIR}/baseline.json"
capture_screen "${ARTIFACTS_DIR}/baseline.png"
read -r input_x input_y baseline_input_height < <(
  node "${ASSERT}" rect "${ARTIFACTS_DIR}/baseline.json" "Message, @files, /commands"
)
read -r model_x model_y _ < <(
  node "${ASSERT}" rect "${ARTIFACTS_DIR}/baseline.json" "combined-model-selector"
)
read -r attach_x attach_y _ < <(
  node "${ASSERT}" rect "${ARTIFACTS_DIR}/baseline.json" "message-input-attach-button"
)
read -r _ header_y _ < <(
  node "${ASSERT}" rect "${ARTIFACTS_DIR}/baseline.json" "workspace-tab-switcher-trigger"
)

adb shell input keyevent HOME
adb shell am start -n "${APP_ID}/.MainActivity" >/dev/null
sleep 1
open_gboard "${input_x}" "${input_y}"
clear_focused_input_with_adb
keyboard_shift="$(read_keyboard_shift)"
adb shell input keyevent 76
sleep 1
capture_screen "${ARTIFACTS_DIR}/command-popover.png"
ad wait 'id="composer-autocomplete-popover"' 10000
ad wait 'text="/exit"' 10000
model_open_y="$((model_y - keyboard_shift))"
adb shell input tap "${model_x}" "${model_open_y}"
sleep 1
capture_screen "${ARTIFACTS_DIR}/model-selector-open.png"
adb shell ime set "${HELPER_IME}" >/dev/null
ad wait 'id="compact-provider-list"' 10000
ad press 'label="Close"' --settle
adb shell input tap "${input_x}" "${input_y}"
clear_focused_input_with_adb
ad wait 'editable=true' 10000

adb shell input keyevent HOME
adb shell am start -n "${APP_ID}/.MainActivity" >/dev/null
sleep 1
open_gboard "${input_x}" "${input_y}"
clear_focused_input_with_adb
adb shell input keyevent 76
sleep 1
adb shell ime set "${HELPER_IME}" >/dev/null
ad wait 'id="composer-autocomplete-popover"' 10000
ad wait 'text="/exit"' 10000
snapshot_json "${ARTIFACTS_DIR}/command-popover.json"
node "${ASSERT}" above-y \
  "${ARTIFACTS_DIR}/command-popover.json" \
  "/exit, Archive the current agent" \
  "$((input_y - baseline_input_height / 2))"
adb shell input keyevent 67
ad wait 'label="Message, @files, /commands"' 10000

ad fill 'label="Message, @files, /commands"' "${MESSAGE}" --settle
snapshot_json "${ARTIFACTS_DIR}/multiline-first.json"
ad fill 'editable=true focused=true' "${MESSAGE}" --settle
snapshot_json "${ARTIFACTS_DIR}/multiline-second.json"
node "${ASSERT}" same-input-height \
  "${ARTIFACTS_DIR}/multiline-first.json" \
  "${ARTIFACTS_DIR}/multiline-second.json"

adb shell input keyevent HOME
adb shell am start -n "${APP_ID}/.MainActivity" >/dev/null
sleep 1
open_gboard "${input_x}" "${input_y}"

keyboard_shift="$(read_keyboard_shift)"
capture_screen "${ARTIFACTS_DIR}/keyboard-open.png"

node "${ASSERT}" same-header \
  "${ARTIFACTS_DIR}/baseline.png" \
  "${ARTIFACTS_DIR}/keyboard-open.png" \
  "$((header_y + 48))"

adb shell ime set "${HELPER_IME}" >/dev/null
ad fill 'editable=true focused=true' "${LONG_MESSAGE}" --settle
open_gboard "${input_x}" "${input_y}"
capture_ui_xml "${ARTIFACTS_DIR}/long-draft-keyboard-open.xml"
capture_screen "${ARTIFACTS_DIR}/long-draft-keyboard-open.png"
node "${ASSERT}" xml-above-y \
  "${ARTIFACTS_DIR}/long-draft-keyboard-open.xml" \
  "Add attachment" \
  "$(read_ime_top)"
adb shell ime set "${HELPER_IME}" >/dev/null
ad fill 'editable=true' "${MESSAGE}" --settle
open_gboard "${input_x}" "${input_y}"
keyboard_shift="$(read_keyboard_shift)"

read -r changes_x changes_y _ < <(
  node "${ASSERT}" rect "${ARTIFACTS_DIR}/multiline-second.json" "Open Changes tab"
)
adb shell input tap "${changes_x}" "$((changes_y - keyboard_shift))"
ad wait 'id="changes-header"' 10000
capture_screen "${ARTIFACTS_DIR}/changes-control-open.png"
ad press 'label="Close Explorer sidebar"' --settle
ad wait "text=\"${AGENT_TITLE}\"" 10000
ad wait 'editable=true' 10000

open_gboard "${input_x}" "${input_y}"
keyboard_shift="$(read_keyboard_shift)"
adb shell input tap "${attach_x}" "$((attach_y - keyboard_shift))"
sleep 1
adb shell ime set "${HELPER_IME}" >/dev/null
ad wait 'id="message-input-attachment-menu-content"' 10000
ad press 540 600 --settle

open_gboard "${input_x}" "${input_y}"
keyboard_shift="$(read_keyboard_shift)"
adb shell input tap 983 "$((attach_y - keyboard_shift))"
wait_for_ime false
adb shell ime set "${HELPER_IME}" >/dev/null
ad wait text "keyboard invariant line one" 10000
snapshot_json "${ARTIFACTS_DIR}/after-submit.json"
node "${ASSERT}" has-exact-text "${ARTIFACTS_DIR}/after-submit.json" "${MESSAGE}"
node "${ASSERT}" same-input-height \
  "${ARTIFACTS_DIR}/baseline.json" \
  "${ARTIFACTS_DIR}/after-submit.json"

open_gboard "${input_x}" "${input_y}"
adb shell input keyevent BACK
wait_for_ime false
sleep 0.5
capture_screen "${ARTIFACTS_DIR}/hidden-focused-baseline.png"

open_gboard "${input_x}" "${input_y}"
node "${STALL_HERMES}" "${METRO_PORT}" 3000 "${APP_ID}" &
stall_pid="$!"
sleep 0.25
adb shell input keyevent BACK
wait_for_ime false
sleep 0.5
capture_screen "${ARTIFACTS_DIR}/hidden-during-js-stall.png"
wait "${stall_pid}"
capture_screen "${ARTIFACTS_DIR}/hidden-after-js-stall.png"
node "${ASSERT}" same-region \
  "${ARTIFACTS_DIR}/hidden-focused-baseline.png" \
  "${ARTIFACTS_DIR}/hidden-during-js-stall.png" \
  1400 \
  430
node "${ASSERT}" same-region \
  "${ARTIFACTS_DIR}/hidden-focused-baseline.png" \
  "${ARTIFACTS_DIR}/hidden-after-js-stall.png" \
  1400 \
  430

echo "Composer keyboard invariants passed"
