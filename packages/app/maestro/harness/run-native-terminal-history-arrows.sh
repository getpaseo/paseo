#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./native-terminal-maestro-common.sh
source "$SCRIPT_DIR/native-terminal-maestro-common.sh"

require_terminal_id

log "Seeding shell history for history-arrows flow"
send_to_terminal "$NATIVE_TERMINAL_ID" "clear" Enter
send_to_terminal "$NATIVE_TERMINAL_ID" "echo MAESTRO_HISTORY_OK-1" Enter

run_maestro_flow "$MAESTRO_DIR/native-terminal-history-arrows.yaml"
