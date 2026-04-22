#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$SCRIPT_DIR/../node_modules/.bin:$PATH"

source "$SCRIPT_DIR/dev-home.sh"
configure_dev_paseo_home

if [ -z "${PASEO_LOCAL_MODELS_DIR}" ]; then
  export PASEO_LOCAL_MODELS_DIR="$HOME/.paseo/models/local-speech"
  mkdir -p "$PASEO_LOCAL_MODELS_DIR"
fi

echo "══════════════════════════════════════════════════════"
echo "  Paseo Dev Daemon"
echo "══════════════════════════════════════════════════════"
echo "  Home:    ${PASEO_HOME}"
echo "  Models:  ${PASEO_LOCAL_MODELS_DIR}"
echo "══════════════════════════════════════════════════════"

export PASEO_CORS_ORIGINS="${PASEO_CORS_ORIGINS:-*}"
export PASEO_NODE_INSPECT="${PASEO_NODE_INSPECT:---inspect=0}"

exec npm run dev:server
