#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./native-terminal-maestro-common.sh
source "$SCRIPT_DIR/native-terminal-maestro-common.sh"

require_terminal_id

log "Seeding scrollback for scroll-no-focus flow"
send_to_terminal "$NATIVE_TERMINAL_ID" "clear" Enter

# Emit a top marker, a screenful of filler, and a bottom marker so scrolling
# up reveals the top marker while the bottom marker is initially visible.
seed_command='{ echo SCROLL_TOP_MARKER; for i in $(seq 1 80); do echo filler-$i; done; echo SCROLL_BOTTOM_MARKER; }'
send_to_terminal "$NATIVE_TERMINAL_ID" "$seed_command" Enter

run_maestro_flow "$MAESTRO_DIR/native-terminal-scroll-does-not-focus.yaml"
assert_maestro_input_does_not_reach_terminal \
  "$NATIVE_TERMINAL_ID" \
  "SCROLL_SHOULD_NOT_TYPE_$RANDOM"
