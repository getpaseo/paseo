#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Download local speech models for Paseo (sherpa-onnx).

Defaults:
  - STT: sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20
  - TTS: kitten-nano-en-v0_1-fp16

Usage:
  scripts/speech/download-sherpa-models.sh [--models-dir DIR] [--with-kokoro] [--with-paraformer]

Preferred:
  npm run speech:download --workspace=@getpaseo/server

Notes:
  - Models are downloaded from the sherpa-onnx GitHub releases.
  - Pocket TTS is downloaded by the Node script (`npm run speech:download --workspace=@getpaseo/server`)
    because it is a file-based HuggingFace model (not a single tarball).
  - Set PASEO_SHERPA_ONNX_MODELS_DIR to override where the daemon looks.
EOF
}

MODELS_DIR=""
WITH_KOKORO=0
WITH_PARAFORMER=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --models-dir)
      MODELS_DIR="${2:-}"
      shift 2
      ;;
    --with-kokoro)
      WITH_KOKORO=1
      shift 1
      ;;
    --with-paraformer)
      WITH_PARAFORMER=1
      shift 1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "${MODELS_DIR}" ]]; then
  if [[ -n "${PASEO_SHERPA_ONNX_MODELS_DIR:-}" ]]; then
    MODELS_DIR="${PASEO_SHERPA_ONNX_MODELS_DIR}"
  elif [[ -n "${PASEO_HOME:-}" ]]; then
    MODELS_DIR="${PASEO_HOME}/models/sherpa-onnx"
  else
    MODELS_DIR="${HOME}/.paseo/models/sherpa-onnx"
  fi
fi

mkdir -p "${MODELS_DIR}"
cd "${MODELS_DIR}"

download_and_extract() {
  local url="$1"
  local filename
  filename="$(basename "$url")"

  echo "Downloading ${filename}..."
  curl -fsSL -O "${url}"
  echo "Extracting ${filename}..."
  tar xf "${filename}"
  rm -f "${filename}"
}

echo "NOTE: This script is deprecated. Prefer: npm run speech:download --workspace=@getpaseo/server" >&2

download_and_extract "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.tar.bz2"
download_and_extract "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kitten-nano-en-v0_1-fp16.tar.bz2"

if [[ "${WITH_PARAFORMER}" -eq 1 ]]; then
  download_and_extract "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2"
fi

if [[ "${WITH_KOKORO}" -eq 1 ]]; then
  download_and_extract "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2"
fi

echo "Done."
echo "Models dir: ${MODELS_DIR}"
