#!/usr/bin/env bash
# Common helpers for native-terminal Maestro flows. Each per-flow harness
# sources this file and calls run_flow_with_setup.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
MAESTRO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_ID="${PASEO_MAESTRO_APP_ID:-sh.paseo.debug}"
SIMULATOR_UDID="${PASEO_MAESTRO_UDID:-47FB40E1-3304-4516-B8BC-D75853EF1B47}"

log() {
  echo "[native-terminal-harness] $*" >&2
}

terminal_ids() {
  cd "$REPO_ROOT"
  npm run --silent cli -- terminal ls --all --json 2>/dev/null \
    | node -e 'const data=[]; process.stdin.on("data", c=>data.push(c)); process.stdin.on("end", ()=>{ const list=JSON.parse(data.join("")); for (const terminal of list) console.log(terminal.id); });'
}

send_to_terminal() {
  local terminal_id="$1"
  shift
  cd "$REPO_ROOT"
  npm run --silent cli -- terminal send-keys "$terminal_id" "$@"
}

set_simulator_clipboard() {
  local text="$1"
  if xcrun simctl pbcopy "$SIMULATOR_UDID" <<< "$text" 2>/dev/null; then
    log "Set simulator clipboard"
  else
    log "WARNING: could not set simulator clipboard; flow may fail"
  fi
}

read_simulator_clipboard() {
  xcrun simctl pbpaste "$SIMULATOR_UDID" 2>/dev/null || true
}

capture_terminal() {
  local terminal_id="$1"
  cd "$REPO_ROOT"
  npm run --silent cli -- terminal capture --scrollback "$terminal_id"
}

write_temp_flow() {
  local name="$1"
  local flow_dir="${TMPDIR:-/tmp}/paseo-native-terminal-maestro-flows"
  mkdir -p "$flow_dir"
  local flow_file
  flow_file="$(mktemp "$flow_dir/$name.XXXXXX")"
  cat >"$flow_file"
  printf '%s\n' "$flow_file"
}

maestro_bin() {
  local bin
  bin="$(command -v maestro || true)"
  if [[ -z "$bin" ]]; then
    log "ERROR: maestro not found on PATH"
    return 1
  fi
  printf '%s\n' "$bin"
}

run_maestro_flow() {
  local flow_file="$1"
  local bin
  bin="$(maestro_bin)"
  local output_dir
  output_dir="$(mktemp -d "${TMPDIR:-/tmp}/paseo-native-terminal-maestro-output.XXXXXX")"
  log "Running Maestro flow $(basename "$flow_file") with screenshots in $output_dir"
  (cd "$output_dir" && "$bin" test --udid "$SIMULATOR_UDID" "$flow_file") >&2
}

run_maestro_flow_allow_failure() {
  local flow_file="$1"
  local bin
  bin="$(maestro_bin)"
  local output_dir
  output_dir="$(mktemp -d "${TMPDIR:-/tmp}/paseo-native-terminal-maestro-output.XXXXXX")"
  log "Running Maestro probe $(basename "$flow_file") with screenshots in $output_dir"
  set +e
  (cd "$output_dir" && "$bin" test --udid "$SIMULATOR_UDID" "$flow_file") >&2
  local status=$?
  set -e
  return "$status"
}

assert_terminal_surface_visible() {
  local flow_file
  flow_file="$(write_temp_flow terminal-visible <<YAML
appId: $APP_ID
---
- assertVisible:
    id: "terminal-virtual-keyboard"
YAML
)"
  run_maestro_flow_allow_failure "$flow_file"
}

ensure_terminal_surface_visible() {
  if assert_terminal_surface_visible; then
    return
  fi

  log "Terminal surface is not visible; trying to create/open a terminal from the workspace header"
  local flow_file
  flow_file="$(write_temp_flow ensure-terminal <<YAML
appId: $APP_ID
---
- runFlow:
    when:
      visible:
        id: "sidebar-sessions"
    commands:
      - tapOn:
          id: "sidebar-close"
      - waitForAnimationToEnd
- tapOn:
    id: "workspace-header-menu-trigger"
- tapOn:
    id: "workspace-header-new-terminal"
- extendedWaitUntil:
    visible:
      id: "terminal-virtual-keyboard"
    timeout: 30000
YAML
)"
  run_maestro_flow "$flow_file"
}

assert_text_visible() {
  local text="$1"
  local flow_file
  flow_file="$(write_temp_flow text-visible <<YAML
appId: $APP_ID
---
- extendedWaitUntil:
    visible: "$text"
    timeout: 8000
YAML
)"
  run_maestro_flow_allow_failure "$flow_file"
}

visible_terminal_id() {
  ensure_terminal_surface_visible
  local ids
  ids="$(terminal_ids)"
  if [[ -z "$ids" ]]; then
    log "ERROR: no terminals found via 'paseo terminal ls --all'"
    return 1
  fi

  local terminal_id
  while IFS= read -r terminal_id; do
    [[ -n "$terminal_id" ]] || continue
    local marker="VT_$RANDOM"
    log "Probing visible terminal candidate $terminal_id"
    send_to_terminal "$terminal_id" "clear" Enter >/dev/null
    send_to_terminal "$terminal_id" "echo $marker" Enter >/dev/null
    if assert_text_visible "$marker"; then
      printf '%s\n' "$terminal_id"
      return
    fi
  done <<< "$ids"

  log "ERROR: no listed terminal matched the visible terminal surface"
  return 1
}

assert_terminal_output_contains() {
  local terminal_id="$1"
  local marker="$2"
  local output
  output="$(capture_terminal "$terminal_id")"
  if [[ "$output" == *"$marker"* ]]; then
    log "PASS: terminal output contains $marker"
    return
  fi
  log "FAIL: terminal output did not contain $marker"
  return 1
}

assert_terminal_output_count_at_least() {
  local terminal_id="$1"
  local marker="$2"
  local minimum="$3"
  local output
  output="$(capture_terminal "$terminal_id")"
  local count
  count="$(MARKER="$marker" OUTPUT="$output" node -e 'const marker = process.env.MARKER ?? ""; const output = process.env.OUTPUT ?? ""; process.stdout.write(String(marker ? output.split(marker).length - 1 : 0));')"
  if (( count >= minimum )); then
    log "PASS: terminal output contains $marker $count times"
    return
  fi
  log "FAIL: terminal output contained $marker $count times, expected at least $minimum"
  return 1
}

assert_maestro_input_does_not_reach_terminal() {
  local terminal_id="$1"
  local marker="$2"
  local flow_file
  flow_file="$(write_temp_flow no-focus-input-probe <<YAML
appId: $APP_ID
---
- inputText: "$marker"
YAML
)"

  if run_maestro_flow_allow_failure "$flow_file"; then
    log "Maestro inputText completed; checking that terminal did not receive $marker"
  else
    log "Maestro inputText had no focused terminal target; checking output anyway"
  fi

  local output
  output="$(capture_terminal "$terminal_id")"
  if [[ "$output" == *"$marker"* ]]; then
    log "FAIL: terminal received no-focus probe $marker"
    return 1
  fi
  log "PASS: terminal did not receive no-focus probe $marker"
}

# Default per-flow setup: find the visible terminal and optionally seed it.
# Callers can override NATIVE_TERMINAL_ID before sourcing.
: "${NATIVE_TERMINAL_ID:=}"

require_terminal_id() {
  if [[ -z "$NATIVE_TERMINAL_ID" ]]; then
    NATIVE_TERMINAL_ID="$(visible_terminal_id)"
  fi
  if [[ -z "$NATIVE_TERMINAL_ID" ]]; then
    log "ERROR: no visible active terminal found"
    return 1
  fi
  log "Using terminal $NATIVE_TERMINAL_ID"
}
