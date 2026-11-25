#!/usr/bin/env bash
# Compile md4c + the WASM wrapper to a single self-contained JS file.
#
# Prerequisites:
#   brew install emscripten    # macOS
#   # or follow https://emscripten.org/docs/getting_started/downloads.html
#
# Usage:
#   bash packages/core/cpp/wasm/build.sh
#
# Output:
#   packages/react-native-enriched-markdown/src/web/wasm/md4c.js
#
# NOTE: the committed md4c.js is an artifact, and the docs describe what the
# *committed* one can do - not what this source can. It was last rebuilt before
# the Video node type was added, so the shipped parser emits no `Video` node and
# three doc pages correctly say video does not render on web:
#   docs/docs/introduction/supported-features.md       (Videos | Web | No)
#   docs/docs/react-native/guides/web-support.md       ("Not supported on web")
#   docs/docs/react-native/api-reference/element-structure.md (the video caution)
# A VideoRenderer, `videoStyle` and the 'Video' type already exist under
# src/web/, so the day this script is run those three pages flip to wrong at
# once. Update them in the same commit as the rebuilt artifact.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CPP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/packages/react-native-enriched-markdown/src/web/wasm}"

mkdir -p "$OUT_DIR"

echo "Building md4c WASM…"

# Compile the C file separately (no -std=c++17)
emcc \
  -I "$CPP_ROOT" \
  -O2 \
  -c "$CPP_ROOT/md4c/md4c.c" \
  -o "$OUT_DIR/md4c.o"

# Compile C++ sources and link everything together
emcc \
  "$SCRIPT_DIR/md4c_wasm.cpp" \
  "$SCRIPT_DIR/ASTSerializer.cpp" \
  "$CPP_ROOT/parser/MD4CParser.cpp" \
  "$OUT_DIR/md4c.o" \
  -I "$CPP_ROOT" \
  -I "$SCRIPT_DIR" \
  -O2 \
  -std=c++17 \
  -Wswitch \
  -s WASM=1 \
  -s SINGLE_FILE=1 \
  -s EXPORTED_FUNCTIONS='["_parseMarkdown"]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","UTF8ToString"]' \
  -s ENVIRONMENT='web' \
  -s MODULARIZE=1 \
  -s EXPORT_NAME='createMd4cModule' \
  -s STACK_SIZE=8MB \
  -s INITIAL_MEMORY=16MB \
  -s MAXIMUM_MEMORY=512MB \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s GROWABLE_ARRAYBUFFERS=0 \
  -o "$OUT_DIR/md4c.js"

rm "$OUT_DIR/md4c.o"

echo "Done → $OUT_DIR/md4c.js"
