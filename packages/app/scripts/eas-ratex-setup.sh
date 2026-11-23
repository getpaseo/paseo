#!/usr/bin/env bash
set -euo pipefail

if [ "${EAS_BUILD_PLATFORM:-}" != "android" ]; then
  exit 0
fi

if ! command -v rustup >/dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi

export PATH="$HOME/.cargo/bin:$PATH"
rustup toolchain install 1.99.1 --profile minimal
rustup default 1.99.1
rustup target add i686-linux-android
cargo install cargo-ndk --version 4.1.2 --locked
