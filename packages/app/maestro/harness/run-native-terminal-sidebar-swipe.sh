#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./native-terminal-maestro-common.sh
source "$SCRIPT_DIR/native-terminal-maestro-common.sh"

require_terminal_id

log "Ensuring terminal is visible for sidebar-swipe flow"
send_to_terminal "$NATIVE_TERMINAL_ID" "clear" Enter
send_to_terminal "$NATIVE_TERMINAL_ID" "echo SIDEBAR_SWIPE_OK" Enter

run_maestro_flow "$MAESTRO_DIR/native-terminal-sidebar-swipe-does-not-focus.yaml"
assert_maestro_input_does_not_reach_terminal \
  "$NATIVE_TERMINAL_ID" \
  "SIDEBAR_SWIPE_SHOULD_NOT_TYPE_$RANDOM"
