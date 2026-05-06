#!/bin/bash
set -e

# Ensure node_modules/.bin is in PATH (for when script runs directly)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$SCRIPT_DIR/../node_modules/.bin:$PATH"

source "$SCRIPT_DIR/dev-home.sh"
configure_dev_paseo_home

# Share speech models with the main install to avoid duplicate downloads
if [ -z "${PASEO_LOCAL_MODELS_DIR}" ]; then
  export PASEO_LOCAL_MODELS_DIR="$HOME/.paseo/models/local-speech"
  mkdir -p "$PASEO_LOCAL_MODELS_DIR"
fi

echo "══════════════════════════════════════════════════════"
echo "  Paseo Dev"
echo "══════════════════════════════════════════════════════"
echo "  Home:    ${PASEO_HOME}"
echo "  Models:  ${PASEO_LOCAL_MODELS_DIR}"
echo "══════════════════════════════════════════════════════"

# Configure the daemon for the Portless app origin and let the app bootstrap
# through the daemon's Portless URL instead of a fixed localhost port.
APP_ORIGIN="$(portless get app)"
DAEMON_ENDPOINT="$(portless get daemon | sed -E 's#^https?://##')"
# Allow any origin in dev so Electron on random ports and Portless URLs all work.
# SECURITY: wildcard CORS is unsafe in production — only acceptable here because
# the daemon binds to localhost and this script is never used for production.
export PASEO_CORS_ORIGINS="*"

# Run both with concurrently
# BROWSER=none prevents auto-opening browser
# EXPO_PUBLIC_LOCAL_DAEMON configures the app to auto-connect to this daemon
concurrently \
  --names "daemon,metro" \
  --prefix-colors "cyan,magenta" \
  "portless run --name daemon sh -c 'PASEO_LISTEN=0.0.0.0:\$PORT exec ./scripts/dev-daemon.sh'" \
  "cd packages/app && BROWSER=none APP_VARIANT=development EXPO_PUBLIC_LOCAL_DAEMON='${DAEMON_ENDPOINT}' portless run --name app npx expo start"
