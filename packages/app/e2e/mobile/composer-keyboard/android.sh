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
BLANK_LINE_DRAFT="$(node -e 'process.stdout.write("\n".repeat(22) + "ddjdj")')"
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
  local detail="${2:---raw}"
  # A transient missing application window is a failed capture, never evidence.
  for attempt in 1 2 3; do
    if ad snapshot "${detail}" --json >"${output_path}"; then return; fi
    sleep 1
  done
  return 1
}

capture_ui_xml() {
  local output_path="$1"
  # The helper reads current accessibility bounds without uiautomator's global
  # idle wait (retained screens can keep that wait busy). It leaves Gboard open.
  # Serialize those same physical bounds for the existing XML assertions.
  snapshot_json "${output_path}.json" --raw
  node "${ASSERT}" snapshot-xml "${output_path}.json" "${output_path}"
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
  # Gboard's first show after an IME switch can take several seconds on a loaded host.
  for _ in $(seq 1 100); do
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
      # The window stops reporting visible when the hide animation starts. Android
      # drops a show request made while it is still running, so let it finish
      # before the next tap.
      sleep 0.75
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
  local x="$1" y="$2" height
  adb shell ime set "${GBOARD_IME}" >/dev/null
  sleep 1
  if ime_is_visible; then
    adb shell input keyevent BACK
    wait_for_ime false
  fi
  # IME switching can restore focus before accessibility reports its new frame.
  # Locate the editor for each tap instead of translating a previous snapshot:
  # an old editor position can now be a background that correctly dismisses it.
  snapshot_json "${ARTIFACTS_DIR}/keyboard-target.json" --raw
  read -r x y height < <(node "${ASSERT}" rect "${ARTIFACTS_DIR}/keyboard-target.json" editable right)
  adb shell input tap "${x}" "${y}"
  wait_for_ime true
  snapshot_json "${ARTIFACTS_DIR}/keyboard-target-open.json" --raw
  read -r x y height < <(node "${ASSERT}" rect "${ARTIFACTS_DIR}/keyboard-target-open.json" editable right)
  adb shell input tap "${x}" "${y}"
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
ad wait 'id="message-input-root"' 90000
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
display_density="$(adb shell wm density | awk '/density:/ { density = $NF } END { print density }')"
node "${ASSERT}" xml-composer-contained \
  "${ARTIFACTS_DIR}/long-draft-keyboard-open.xml" \
  "$(read_ime_top)" \
  "${display_density}"
# Emptying a capped blank-line draft with Gboard's hold-to-delete must return the input to
# its baseline height. Fabric only re-measures the Android input when its text prop changes,
# so the editing input renders again after every edit
# (packages/app/src/components/ui/text-input/text-input.native.tsx). The sequence mirrors the
# report: grow to the cap, close and reopen the keyboard, hold delete from the middle of the
# draft, jump to the end, hold delete again. The first hold-delete must start mid-draft: from
# the end, the pre-fix input also returns to baseline. Backspace sits on Gboard's third key
# row on the paseo-api35 layout.
adb shell ime set "${HELPER_IME}" >/dev/null
ad fill 'editable=true' "${BLANK_LINE_DRAFT}" --settle
open_gboard "${input_x}" "${input_y}"
adb shell input keyevent BACK
wait_for_ime false
open_gboard "${input_x}" "${input_y}"
adb shell input keycombination 113 122
adb shell input keyevent 20 20 20 20 20 20 20 20
screen_width="$(adb shell wm size | sed -n 's/.*: \([0-9]*\)x.*/\1/p' | tail -1)"
backspace_x="$((screen_width - 85))"
backspace_y="$(($(read_ime_top) + 507))"
adb shell input swipe "${backspace_x}" "${backspace_y}" "${backspace_x}" "${backspace_y}" 8000
adb shell input keycombination 113 123
adb shell input swipe "${backspace_x}" "${backspace_y}" "${backspace_x}" "${backspace_y}" 12000
adb shell ime set "${HELPER_IME}" >/dev/null
ad wait 'label="Message, @files, /commands"' 10000
snapshot_json "${ARTIFACTS_DIR}/after-hold-delete.json"
node "${ASSERT}" same-input-height \
  "${ARTIFACTS_DIR}/baseline.json" \
  "${ARTIFACTS_DIR}/after-hold-delete.json"

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

ad press 'id="menu-button"' --settle
ad press 'id="sidebar-global-new-workspace"' --settle
ad wait 'id="workspace-create-submit"' 10000
adb shell ime set "${HELPER_IME}" >/dev/null
ad fill 'editable=true' "x" --settle
snapshot_json "${ARTIFACTS_DIR}/new-workspace-short-draft.json"
read -r new_input_x new_input_y _ < <(
  node "${ASSERT}" rect "${ARTIFACTS_DIR}/new-workspace-short-draft.json" "editable"
)
open_gboard "${new_input_x}" "${new_input_y}"
capture_ui_xml "${ARTIFACTS_DIR}/new-workspace-short-draft-keyboard-open.xml"
# Typing more lines moves the setup fields up with the composer instead of
# hiding their bottom rows behind it.
adb shell input keycombination 113 123
adb shell input keyevent 66 66 66
adb shell input text grown
sleep 1
capture_ui_xml "${ARTIFACTS_DIR}/new-workspace-grown-draft-keyboard-open.xml"
capture_screen "${ARTIFACTS_DIR}/new-workspace-grown-draft-keyboard-open.png"
node "${ASSERT}" xml-fields-follow-growth \
  "${ARTIFACTS_DIR}/new-workspace-short-draft-keyboard-open.xml" \
  "${ARTIFACTS_DIR}/new-workspace-grown-draft-keyboard-open.xml"

adb shell ime set "${HELPER_IME}" >/dev/null
ad fill 'editable=true' "${LONG_MESSAGE}" --settle
snapshot_json "${ARTIFACTS_DIR}/new-workspace-long-draft.json"
read -r new_input_x new_input_y new_input_height < <(
  node "${ASSERT}" rect "${ARTIFACTS_DIR}/new-workspace-long-draft.json" "editable"
)
# The editor shrinks when the keyboard opens. Its bottom stays anchored, while
# its old center can move into the setup fields after the height constraint.
new_input_y="$((new_input_y + new_input_height / 2 - 8))"
open_gboard "${new_input_x}" "${new_input_y}"
capture_ui_xml "${ARTIFACTS_DIR}/new-workspace-long-draft-keyboard-open.xml"
capture_screen "${ARTIFACTS_DIR}/new-workspace-long-draft-keyboard-open.png"
node "${ASSERT}" xml-composer-contained \
  "${ARTIFACTS_DIR}/new-workspace-long-draft-keyboard-open.xml" \
  "$(read_ime_top)" \
  "${display_density}"

# Dismissing the keyboard moves the composer down at its editing height and
# brings the setup fields back fully visible above it.
adb shell input keyevent BACK
wait_for_ime false
capture_ui_xml "${ARTIFACTS_DIR}/new-workspace-long-draft-keyboard-closed.xml"
capture_screen "${ARTIFACTS_DIR}/new-workspace-long-draft-keyboard-closed.png"
node "${ASSERT}" same-input-height \
  "${ARTIFACTS_DIR}/new-workspace-long-draft-keyboard-open.xml" \
  "${ARTIFACTS_DIR}/new-workspace-long-draft-keyboard-closed.xml"
node "${ASSERT}" xml-fields-above-composer \
  "${ARTIFACTS_DIR}/new-workspace-long-draft-keyboard-closed.xml"

# All hosts run the same scenario; only navigation differs.
# For the shared scenario, tap the editor's blank right edge once. Tapping
# text again after opening invokes Android's spelling menu for long drafts.
open_editor_keyboard() {
  local x="$1" y="$2"
  local current_ime
  current_ime="$(adb shell settings get secure default_input_method)"
  if [[ "${current_ime}" != "${GBOARD_IME}" ]]; then
    adb shell ime set "${GBOARD_IME}" >/dev/null
    sleep 1
  fi
  if ! ime_is_visible; then adb shell input tap "${x}" "${y}"; fi
  wait_for_ime true
}

prepare_composer() {
  adb shell ime set "${HELPER_IME}" >/dev/null
  wait_for_ime false
  clear_input
  wait_for_ime false
  snapshot_json "${ARTIFACTS_DIR}/overlay-input.json"
  read -r overlay_x overlay_y overlay_h < <(node "${ASSERT}" rect "${ARTIFACTS_DIR}/overlay-input.json" editable right)
  if [[ "$1" == open ]]; then open_editor_keyboard "${overlay_x}" "${overlay_y}"; fi
}
press_composer_control() {
  local x y h
  snapshot_json "${ARTIFACTS_DIR}/overlay-input.json"
  read -r x y h < <(node "${ASSERT}" rect "${ARTIFACTS_DIR}/overlay-input.json" "$1")
  adb shell input tap "${x}" "${y}"
}

run_host_overlays() {
  local host="$1"
  for mode in closed open; do
    for query in / @README; do
      prepare_composer closed
      adb shell input text "${query}"
      if [[ "${mode}" == open ]]; then open_editor_keyboard "${overlay_x}" "${overlay_y}"; fi
      ad wait 'id="composer-autocomplete-popover"' 10000
      local kind=commands
      if [[ "${query}" == @* ]]; then kind=files; fi
      capture_screen "${ARTIFACTS_DIR}/${host}-${kind}-${mode}.png"
      clear_focused_input_with_adb
      echo "PASS host=${host}: ${kind} popover keyboard=${mode}"
    done
    prepare_composer "${mode}"
    press_composer_control combined-model-selector
    ad wait 'id="compact-provider-list"' 10000
    capture_screen "${ARTIFACTS_DIR}/${host}-model-${mode}.png"
    ad press 'label="Close"' --settle
    echo "PASS host=${host}: model selector keyboard=${mode}"
    prepare_composer "${mode}"
    press_composer_control message-input-attach-button
    ad wait 'id="message-input-attachment-menu-content"' 10000
    capture_screen "${ARTIFACTS_DIR}/${host}-attachments-${mode}.png"
    ad press 'id="message-input-attachment-menu-item-github"' --settle
    ad wait 'text="Attach issue or PR"' 10000
    capture_screen "${ARTIFACTS_DIR}/${host}-forge-${mode}.png"
    adb shell input tap 540 400
    ad wait 'id="message-input-attach-button"' 10000
    echo "PASS host=${host}: attachment menu and forge picker keyboard=${mode}"
  done
}

run_host_scroll() {
  local host="$1"
  local prefix="${ARTIFACTS_DIR}/${host}-native-scroll"
  prepare_composer closed
  if [[ "${host}" == new-workspace ]]; then
    ad press 'id="workspace-create-isolation-trigger"' --settle
    ad press 'text="Local"' --settle
  fi
  # Submit through each real host; draft/workspace creation then mounts its chat.
  # A selectable mock model keeps this test independent of provider credentials.
  press_composer_control combined-model-selector
  ad wait 'id="model-search-all-input"' 10000
  ad fill 'id="model-search-all-input"' 'Ten second stream'
  ad wait 'id="model-row-mock-ten-second-stream"' 10000
  ad press 'id="model-row-mock-ten-second-stream"' --settle
  ad press 'label="Close"' --settle
  adb shell ime set "${HELPER_IME}" >/dev/null
  wait_for_ime false
  local scroll_message
  scroll_message="$(node -e 'process.stdout.write(Array.from({length: 50}, (_, i) => `Native scroll fixture ${i}: distinct history row after submitting from a dock host.`).join("\n"))')"
  ad fill 'editable=true' "${scroll_message}"
  if [[ "${host}" == new-workspace ]]; then
    ad press 'id="workspace-create-submit"' --settle
  else
    ad press 'label="Send message"' --settle
  fi
  ad wait 'id="agent-chat-scroll"' 45000
  sleep 15
  ad wait 'text="(end of synthetic stream)"' 45000
  if ime_is_visible; then adb shell input keyevent BACK; fi
  wait_for_ime false
  # Streaming/re-renders can mask responder interception. Exercise idle JS after
  # submit, and again after returning to the bottom and letting the scrollbar fade.
  sleep 5
  capture_screen "${prefix}-submitted.png"
  adb shell input swipe 540 800 540 1400 250
  sleep 2
  capture_screen "${prefix}-after-submit-swipe.png"
  node "${ASSERT}" stream-moved "${prefix}-submitted.png" "${prefix}-after-submit-swipe.png"
  for _ in 1 2 3 4 5 6; do adb shell input swipe 540 1400 540 600 120; done
  sleep 5
  capture_screen "${prefix}-bottom-idle.png"
  adb shell input swipe 540 800 540 1400 250
  sleep 2
  capture_screen "${prefix}-after-idle-swipe.png"
  node "${ASSERT}" stream-moved "${prefix}-bottom-idle.png" "${prefix}-after-idle-swipe.png"
  echo "PASS host=${host}: native stream swipe after submit and after idle at bottom"
}

run_host_scenario() {
  local host="$1"
  local prefix="${ARTIFACTS_DIR}/${host}"
  echo "BEGIN host=${host}"
  adb shell ime set "${HELPER_IME}" >/dev/null
  wait_for_ime false
  clear_input
  ad keyboard dismiss || true
  snapshot_json "${prefix}-empty.json"
  capture_screen "${prefix}-empty.png"
  local x y height
  read -r x y height < <(node "${ASSERT}" rect "${prefix}-empty.json" editable right)
  open_editor_keyboard "${x}" "${y}"
  capture_ui_xml "${prefix}-empty-open.xml"
  capture_screen "${prefix}-empty-open.png"
  node "${ASSERT}" same-input-height "${prefix}-empty.json" "${prefix}-empty-open.xml"
  # The left gutter above a one-line composer is empty on every host.
  local dismiss_x dismiss_y
  read -r dismiss_x dismiss_y < <(node "${ASSERT}" xml-background-point "${prefix}-empty-open.xml" content)
  adb shell input tap "${dismiss_x}" "${dismiss_y}"
  wait_for_ime false
  capture_ui_xml "${prefix}-content-dismissed.xml"
  node "${ASSERT}" same-input-height "${prefix}-empty-open.xml" "${prefix}-content-dismissed.xml"
  open_editor_keyboard "${x}" "${y}"
  adb shell input text short
  capture_ui_xml "${prefix}-short.xml"
  adb shell input keyevent 66 66 66
  adb shell input text grown
  capture_ui_xml "${prefix}-grown.xml"
  capture_screen "${prefix}-grown.png"
  node "${ASSERT}" xml-content-follow-growth "${prefix}-short.xml" "${prefix}-grown.xml"

  adb shell ime set "${HELPER_IME}" >/dev/null
  wait_for_ime false
  ad fill 'editable=true' "${LONG_MESSAGE}" --settle
  snapshot_json "${prefix}-long.json"
  read -r x y height < <(node "${ASSERT}" rect "${prefix}-long.json" editable right)
  open_editor_keyboard "${x}" "${y}"
  capture_ui_xml "${prefix}-long-open.xml"
  capture_screen "${prefix}-long-open.png"
  node "${ASSERT}" xml-composer-contained "${prefix}-long-open.xml" "$(read_ime_top)" "${display_density}"
  # At the cap the header remains reachable even when all content is clipped.
  read -r dismiss_x dismiss_y < <(node "${ASSERT}" xml-background-point "${prefix}-long-open.xml" header)
  adb shell input tap "${dismiss_x}" "${dismiss_y}"
  wait_for_ime false
  capture_ui_xml "${prefix}-header-dismissed.xml"
  node "${ASSERT}" same-input-height "${prefix}-long-open.xml" "${prefix}-header-dismissed.xml"
  snapshot_json "${prefix}-header-dismissed.json"
  read -r x y height < <(node "${ASSERT}" rect "${prefix}-header-dismissed.json" editable right)
  open_editor_keyboard "${x}" "${y}"
  adb shell input keyevent BACK
  wait_for_ime false
  capture_ui_xml "${prefix}-long-closed.xml"
  capture_screen "${prefix}-long-closed.png"
  node "${ASSERT}" same-input-height "${prefix}-long-open.xml" "${prefix}-long-closed.xml"
  local navigation_top
  navigation_top="$(adb shell dumpsys window | sed -n 's/.*type=navigationBars frame=\[0,\([0-9][0-9]*\)\].*/\1/p' | head -1)"
  node "${ASSERT}" xml-composer-contained "${prefix}-long-closed.xml" "${navigation_top}" "${display_density}"
  snapshot_json "${prefix}-long-closed.json"
  read -r x y height < <(node "${ASSERT}" rect "${prefix}-long-closed.json" editable right)
  open_editor_keyboard "${x}" "${y}"
  capture_ui_xml "${prefix}-long-reopened.xml"
  capture_screen "${prefix}-long-reopened.png"
  node "${ASSERT}" same-input-height "${prefix}-long-open.xml" "${prefix}-long-reopened.xml"

  adb shell ime set "${HELPER_IME}" >/dev/null
  wait_for_ime false
  ad fill 'editable=true' "${BLANK_LINE_DRAFT}" --settle
  open_editor_keyboard "${x}" "${y}"
  adb shell input keyevent BACK
  wait_for_ime false
  open_editor_keyboard "${x}" "${y}"
  adb shell input keycombination 113 122
  adb shell input keyevent 20 20 20 20 20 20 20 20
  local delete_y="$(($(read_ime_top) + 507))"
  adb shell input swipe "${backspace_x}" "${delete_y}" "${backspace_x}" "${delete_y}" 8000
  adb shell input keycombination 113 123
  adb shell input swipe "${backspace_x}" "${delete_y}" "${backspace_x}" "${delete_y}" 12000
  capture_ui_xml "${prefix}-cleared.xml"
  capture_screen "${prefix}-cleared.png"
  node "${ASSERT}" same-input-height "${prefix}-empty-open.xml" "${prefix}-cleared.xml"
  adb shell input keyevent BACK
  wait_for_ime false
  snapshot_json "${prefix}-cleared-closed.json"
  read -r x y height < <(node "${ASSERT}" rect "${prefix}-cleared-closed.json" editable right)
  capture_screen "${prefix}-stall-baseline.png"
  capture_screen "${prefix}-cleared-closed.png"
  open_editor_keyboard "${x}" "${y}"
  node "${STALL_HERMES}" "${METRO_PORT}" 3000 "${APP_ID}" &
  local stall_pid="$!"
  sleep 0.25
  adb shell input keyevent BACK
  wait_for_ime false
  sleep 0.5
  capture_screen "${prefix}-during-stall.png"
  wait "${stall_pid}"
  capture_screen "${prefix}-after-stall.png"
  node "${ASSERT}" same-region "${prefix}-stall-baseline.png" "${prefix}-during-stall.png" 1400 430
  node "${ASSERT}" same-region "${prefix}-stall-baseline.png" "${prefix}-after-stall.png" 1400 430
  echo "PASS host=${host}: growth, header/keyboard/safe-area bounds, close/reopen height, hold-delete baseline, content/header dismissal, JS-stall motion"
  run_host_overlays "${host}"
  run_host_scroll "${host}"
}

adb shell am start -a android.intent.action.VIEW -d "paseo://h/${SERVER_ID}/agent/${agent_id}" "${APP_ID}" >/dev/null
ad wait "text=\"${AGENT_TITLE}\"" 10000
run_host_scenario chat
ad keyboard dismiss || true
ad press 'id="workspace-header-menu-trigger"' --settle
ad wait 'id="workspace-header-new-agent"' 10000
ad press 'id="workspace-header-new-agent"' --settle
ad wait 'text="New Agent"' 10000
run_host_scenario workspace-draft
ad keyboard dismiss || true
ad press 'id="menu-button"' --settle
ad press 'id="sidebar-global-new-workspace"' --settle
ad wait 'id="workspace-create-submit"' 10000
run_host_scenario new-workspace

echo "Composer keyboard invariants passed"
