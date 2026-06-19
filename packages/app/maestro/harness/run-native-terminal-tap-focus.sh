#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./native-terminal-maestro-common.sh
source "$SCRIPT_DIR/native-terminal-maestro-common.sh"

require_terminal_id

log "Clearing terminal for tap-focus flow"
send_to_terminal "$NATIVE_TERMINAL_ID" "clear" Enter

run_maestro_flow "$MAESTRO_DIR/native-terminal-tap-focus-keyboard.yaml"
assert_terminal_output_contains "$NATIVE_TERMINAL_ID" "MAESTRO_TAP_FOCUS_OK"
