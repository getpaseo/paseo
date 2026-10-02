#!/usr/bin/env bash
set -euo pipefail

# Run only on a task-owned foldable emulator with a connected Paseo debug app.
# Usage: native-fold-history-route.android.sh <adb-serial> <avd-name> <agent-device-session> <workspace-name>
serial=${1:?adb serial required}
avd_name=${2:?expected AVD name required}
session=${3:?agent-device session required}
workspace_name=${4:?workspace name required}

actual_avd=$(adb -s "$serial" shell getprop ro.boot.qemu.avd_name | tr -d '\r')
if [[ "$actual_avd" != "$avd_name" ]]; then
  echo "Refusing device $serial: expected $avd_name, found $actual_avd" >&2
  exit 2
fi

initial_state=$(adb -s "$serial" shell cmd device_state print-state | tr -d '\r')
if [[ "$initial_state" != "0" && "$initial_state" != "2" ]]; then
  echo "Expected CLOSED=0 or OPENED=2; got $initial_state" >&2
  exit 2
fi
trap 'adb -s "$serial" shell cmd device_state state "$initial_state" >/dev/null' EXIT

wait_for_history() {
  local snapshot
  for _ in {1..20}; do
    snapshot=$(agent-device snapshot --session "$session" -i)
    if rg -q '\[group\] "History"' <<<"$snapshot"; then
      return 0
    fi
    sleep 0.5
  done
  echo "$snapshot" >&2
  return 1
}

wait_for_compact_workspace() {
  local snapshot
  for _ in {1..20}; do
    snapshot=$(agent-device snapshot --session "$session" -i)
    if rg -q 'Unable to find node on an unmounted component|RootErrorBoundary' <<<"$snapshot"; then
      echo "Workspace hit a React Native error after folding" >&2
      echo "$snapshot" >&2
      return 1
    fi
    if rg -q 'Switch tabs \(' <<<"$snapshot"; then
      return 0
    fi
    sleep 0.5
  done
  echo "$snapshot" >&2
  return 1
}

adb -s "$serial" shell cmd device_state state 2
sleep 3
agent-device press 'text="History"' --session "$session"
if ! wait_for_history; then
  echo "History route did not open on the wide foldable" >&2
  exit 1
fi

adb -s "$serial" shell cmd device_state state 0
sleep 4
if ! wait_for_history; then
  echo "History route was lost after folding CLOSED" >&2
  exit 1
fi

adb -s "$serial" shell cmd device_state state 2
sleep 4
if ! wait_for_history; then
  echo "History route was lost after unfolding OPENED" >&2
  exit 1
fi
agent-device press "label=\"$workspace_name\"" --session "$session"
adb -s "$serial" shell cmd device_state state 0
sleep 4
if ! wait_for_compact_workspace; then
  echo "Compact workspace failed after returning from History" >&2
  exit 1
fi
echo "History retained and compact workspace mounted after OPENED -> CLOSED -> OPENED -> CLOSED"
