#!/usr/bin/env bash
# Fork-only. Builds the macOS desktop app locally at a fork version and restores
# the committed package.json files afterwards, so the working tree stays identical
# to upstream on every version line. See docs/fork.md.
#
#   scripts/fork/build-desktop.sh 1.0.1
set -euo pipefail

version="${1:-}"
if [[ -z "$version" ]]; then
  echo "usage: scripts/fork/build-desktop.sh <version>" >&2
  exit 1
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

if [[ -n "$(git status --porcelain -- package.json 'packages/*/package.json')" ]]; then
  echo "package.json files are already modified; commit or discard them first" >&2
  exit 1
fi

restore() {
  git checkout --quiet -- package.json 'packages/*/package.json'
}
trap restore EXIT

node scripts/fork/stamp-version.mjs "$version"
PASEO_DESKTOP_SMOKE=1 npm run build:desktop -- --mac --arm64 -c.mac.notarize=false

echo
echo "Built $version into packages/desktop/release/. Check the bundle before installing:"
echo "  grep owner packages/desktop/release/mac-arm64/Paseo.app/Contents/Resources/app-update.yml"
