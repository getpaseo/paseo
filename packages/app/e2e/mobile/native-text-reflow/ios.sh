#!/usr/bin/env bash
set -euo pipefail

: "${PASEO_NATIVE_TEXT_REFLOW_PID:?Set the PID of your task-owned Paseo iOS simulator app}"
: "${PASEO_NATIVE_TEXT_REFLOW_LOG:?Set the test output log path}"

if [[ "$(ps -p "$PASEO_NATIVE_TEXT_REFLOW_PID" -o comm=)" != *PaseoDebug.app/PaseoDebug ]]; then
  echo "Expected a running PaseoDebug simulator app" >&2
  exit 1
fi

probe_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
xcrun lldb --batch -p "$PASEO_NATIVE_TEXT_REFLOW_PID" \
  -o "command script import $probe_dir/ios.py" \
  -o "process detach" -o quit > "$PASEO_NATIVE_TEXT_REFLOW_LOG" 2>&1

grep '^NATIVE_REFLOW_' "$PASEO_NATIVE_TEXT_REFLOW_LOG"
grep -q '^NATIVE_REFLOW_PASS narrow=240 wide=500 recycled=530,530 selection=12:9$' "$PASEO_NATIVE_TEXT_REFLOW_LOG"
