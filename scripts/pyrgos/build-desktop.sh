#!/usr/bin/env bash
# Desktop installer build for Pyrgos Paseo (Electron). Run on the host that ships the installer:
# the Windows PC builds the Windows installer (use build-desktop.ps1 there). Not run in CI or on the lab.
# Usage: scripts/pyrgos/build-desktop.sh
# Output: packages/desktop/release/ (installer + latest*.yml). Copy it out of git; it is gitignored.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
npm ci
npm run build:desktop
ls -l packages/desktop/release
