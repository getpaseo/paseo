#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./native-terminal-maestro-common.sh
source "$SCRIPT_DIR/native-terminal-maestro-common.sh"

require_terminal_id

log "Seeding selectable text for selection-drag flow"
send_to_terminal "$NATIVE_TERMINAL_ID" "clear" Enter
send_to_terminal "$NATIVE_TERMINAL_ID" "echo SELECT_DRAG_OK" Enter

run_maestro_flow "$MAESTRO_DIR/native-terminal-selection-drag-does-not-focus.yaml"
assert_maestro_input_does_not_reach_terminal \
  "$NATIVE_TERMINAL_ID" \
  "SELECTION_DRAG_SHOULD_NOT_TYPE_$RANDOM"

log "Reading simulator clipboard"
CLIPBOARD="$(read_simulator_clipboard)"
if [[ -n "$CLIPBOARD" && ("SELECT_DRAG_OK" == "$CLIPBOARD"* || "$CLIPBOARD" == *"SELECT_DRAG_OK"*) ]]; then
  log "PASS: Copy wrote selected terminal marker text: $CLIPBOARD"
else
  log "FAIL: Copy did not write selected terminal marker text: $CLIPBOARD"
  exit 1
fi
