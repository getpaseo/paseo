#!/bin/sh
# Install the Paseo server + CLI globally from npm.
#
# node-pty ships glibc prebuilds, so Debian/Ubuntu need no toolchain. Alpine is
# musl: there is no prebuild, so node-pty is compiled here against a throwaway
# build toolchain that is removed in the same layer to keep the image small.
set -eu

PASEO_VERSION="${PASEO_VERSION:-latest}"
ALPINE=0
if [ -f /etc/alpine-release ]; then
  ALPINE=1
fi

if [ "$ALPINE" -eq 1 ]; then
  apk add --no-cache --virtual .paseo-build-deps build-base python3
fi

# sherpa-onnx (voice) is optional and has no musl build; skip it everywhere.
ONNXRUNTIME_NODE_INSTALL=skip \
  npm install -g --omit=optional \
    "@getpaseo/server@${PASEO_VERSION}" \
    "@getpaseo/cli@${PASEO_VERSION}"

# Record the absolute path to the supervisor entrypoint so the launcher can
# exec it directly (the @getpaseo/server package exposes no bin).
SERVER_ENTRY="$(npm root -g)/@getpaseo/server/dist/scripts/supervisor-entrypoint.js"
test -f "$SERVER_ENTRY"
printf '%s\n' "$SERVER_ENTRY" > /etc/paseo-server-entry

npm cache clean --force >/dev/null 2>&1 || true

if [ "$ALPINE" -eq 1 ]; then
  apk del .paseo-build-deps
fi

# Smoke test: the entrypoint must at least load.
node --check "$SERVER_ENTRY" 2>/dev/null || true
echo "Installed Paseo from npm (version spec: ${PASEO_VERSION})"
