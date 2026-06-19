#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./native-terminal-maestro-common.sh
source "$SCRIPT_DIR/native-terminal-maestro-common.sh"

require_terminal_id

log "Seeding terminal virtual keyboard UX flow"
send_to_terminal "$NATIVE_TERMINAL_ID" "clear" Enter
send_to_terminal "$NATIVE_TERMINAL_ID" "printf '\n\n\n\nMAESTRO_COPY_OK\n'" Enter
send_to_terminal "$NATIVE_TERMINAL_ID" "echo MAESTRO_VK_HISTORY_OK" Enter
set_simulator_clipboard "echo MAESTRO_PASTE_OK"

run_maestro_flow "$MAESTRO_DIR/native-terminal-virtual-keyboard-ux.yaml"

assert_terminal_output_count_at_least "$NATIVE_TERMINAL_ID" "MAESTRO_VK_HISTORY_OK" 2
assert_terminal_output_contains "$NATIVE_TERMINAL_ID" "MAESTRO_TOGGLE_INPUT_OK"
assert_terminal_output_contains "$NATIVE_TERMINAL_ID" "MAESTRO_PASTE_OK"

log "Reading simulator clipboard after Copy"
CLIPBOARD="$(read_simulator_clipboard)"
if [[ -n "$CLIPBOARD" && ("MAESTRO_COPY_OK" == "$CLIPBOARD"* || "$CLIPBOARD" == *"MAESTRO_COPY_OK"*) ]]; then
  log "PASS: Copy wrote selected terminal text: $CLIPBOARD"
else
  log "FAIL: Copy did not write selected terminal text: $CLIPBOARD"
  exit 1
fi
