#!/usr/bin/env bash
set -euo pipefail
TASK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$TASK_ROOT"
export APP_VARIANT=enhanced
npm run build:enhanced-icons
npm run build:app-deps
npm run build:pdf-runtime --workspace=@getpaseo/app
npm run build:server
npm run build:main --workspace=@getpaseo/desktop
(cd packages/app && PASEO_WEB_PLATFORM=electron npx expo export --platform web)
# Ad-hoc signing is for this local development build; release signing remains configurable.
(cd packages/desktop && CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --config electron-builder.enhanced.yml --dir --mac --arm64 --config.electronDist=../../node_modules/electron/dist --config.mac.hardenedRuntime=false)
