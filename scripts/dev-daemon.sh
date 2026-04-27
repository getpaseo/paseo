#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$SCRIPT_DIR/../node_modules/.bin:$PATH"

source "$SCRIPT_DIR/dev-home.sh"
configure_dev_hubcode_home

if [ -z "${HUBCODE_LOCAL_MODELS_DIR}" ]; then
  export HUBCODE_LOCAL_MODELS_DIR="$HOME/.hubcode/models/local-speech"
  mkdir -p "$HUBCODE_LOCAL_MODELS_DIR"
fi

echo "══════════════════════════════════════════════════════"
echo "  Hubcode Dev Daemon"
echo "══════════════════════════════════════════════════════"
echo "  Home:    ${HUBCODE_HOME}"
echo "  Models:  ${HUBCODE_LOCAL_MODELS_DIR}"
echo "══════════════════════════════════════════════════════"

export HUBCODE_CORS_ORIGINS="${HUBCODE_CORS_ORIGINS:-*}"
export HUBCODE_NODE_INSPECT="${HUBCODE_NODE_INSPECT:---inspect=0}"

exec npm run dev:server
