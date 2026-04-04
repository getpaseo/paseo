#!/usr/bin/env bash
# Verification loop for sidebar theme bug.
#
# Maestro can't toggle iOS appearance, so this script bridges the gap:
# toggle appearance via xcrun simctl, then run Maestro to verify the sidebar
# still works. Runs N iterations to catch intermittent failures.
#
# Usage:
#   bash packages/app/maestro/test-sidebar-theme.sh [iterations] [wait_seconds]
#   bash packages/app/maestro/test-sidebar-theme.sh 6 1
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
FLOW="$REPO_ROOT/packages/app/maestro/sidebar-theme-repro.yaml"
OUT_DIR="/tmp/sidebar-theme-test-$(date +%s)"
ITERATIONS="${1:-3}"
WAIT_SECS="${2:-1}"
mkdir -p "$OUT_DIR"

echo "=== Sidebar Theme Bug Verification ==="
echo "Output dir: $OUT_DIR"
echo "Iterations: $ITERATIONS, wait after toggle: ${WAIT_SECS}s"

FAILURES=0

for i in $(seq 1 "$ITERATIONS"); do
  echo ""
  echo "========== Iteration $i / $ITERATIONS =========="

  CURRENT=$(xcrun simctl ui booted appearance 2>&1 | tr -d '[:space:]')
  echo "Current appearance: $CURRENT"

  if [ "$CURRENT" = "dark" ]; then
    xcrun simctl ui booted appearance light
    echo "Switched to light mode"
  else
    xcrun simctl ui booted appearance dark
    echo "Switched to dark mode"
  fi

  echo "Waiting ${WAIT_SECS}s..."
  sleep "$WAIT_SECS"

  ITER_DIR="$OUT_DIR/iter-$i"
  mkdir -p "$ITER_DIR"

  # Run maestro from the output dir so takeScreenshot artifacts land there
  if (cd "$ITER_DIR" && maestro test "$FLOW") 2>&1 | tee "$ITER_DIR/test.log"; then
    echo "  -> PASS (iteration $i)"
  else
    echo "  -> FAIL (iteration $i) — bug reproduced!"
    FAILURES=$((FAILURES + 1))
    xcrun simctl io booted screenshot "$ITER_DIR/failure-state.png" 2>/dev/null || true
  fi
done

# Restore to dark mode
xcrun simctl ui booted appearance dark

echo ""
echo "=== Summary: $FAILURES failures out of $ITERATIONS iterations ==="
echo "Output: $OUT_DIR"
