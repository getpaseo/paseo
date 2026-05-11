#!/usr/bin/env bash
# Fix workspace-local lockfile entries and update the Nix dependency hash.
# Requires: node, npm, nix
#
# Usage:
#   ./scripts/update-nix.sh          # fix lockfile + update hash
#   ./scripts/update-nix.sh --check  # verify everything is up to date (CI mode)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCK_FILE="$ROOT_DIR/package-lock.json"
HASH_FILE="$ROOT_DIR/nix/npm-deps.hash"

CHECK_MODE=false
if [[ "${1:-}" == "--check" ]]; then
  CHECK_MODE=true
fi

# 1. Fix lockfile (add resolved/integrity for workspace-local entries)
#    Workaround for https://github.com/npm/cli/issues/4460
echo "Fixing lockfile..."
node "$SCRIPT_DIR/fix-lockfile.mjs" "$LOCK_FILE"

# 2. Prefetch deps and compute hash
echo "Prefetching npm dependencies..."

# Resolve prefetch-npm-deps from the same nixpkgs pinned in flake.lock
NIXPKGS_URL="$(node -p "
  const l = JSON.parse(require('fs').readFileSync('$ROOT_DIR/flake.lock', 'utf8'));
  const n = l.nodes.nixpkgs.locked;
  'github:' + n.owner + '/' + n.repo + '/' + n.rev;
")"

STDERR_LOG="$(mktemp)"
trap "rm -f '$STDERR_LOG'" EXIT

if ! NEW_HASH="$(nix shell "${NIXPKGS_URL}#prefetch-npm-deps" -c prefetch-npm-deps "$LOCK_FILE" 2>"$STDERR_LOG")"; then
  echo "ERROR: prefetch-npm-deps failed:" >&2
  tail -20 "$STDERR_LOG" >&2
  exit 1
fi
echo "Computed hash: $NEW_HASH"

# 3. Read current hash from the sidecar file
CURRENT_HASH="$(tr -d '[:space:]' < "$HASH_FILE")"

if [[ "$NEW_HASH" == "$CURRENT_HASH" ]]; then
  echo "Hash is already up to date."
else
  if $CHECK_MODE; then
    echo "ERROR: npmDepsHash is stale."
    echo "  current: $CURRENT_HASH"
    echo "  correct: $NEW_HASH"
    echo "Run ./scripts/update-nix.sh to fix."
    exit 1
  fi

  echo "Updating nix/npm-deps.hash..."
  printf '%s\n' "$NEW_HASH" > "$HASH_FILE"
  echo "Updated: $CURRENT_HASH -> $NEW_HASH"
fi
