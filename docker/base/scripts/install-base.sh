#!/bin/sh
# Install base runtime dependencies + Node.js 22.
# Detects the package manager (apt vs apk) so one script covers all distros.
set -eu

if command -v apk >/dev/null 2>&1; then
  # Alpine. nodejs/npm come from the distro repos (Alpine 3.21+ ships Node 22).
  apk add --no-cache \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    nodejs \
    npm \
    procps \
    shadow \
    tar \
    tini \
    xz
elif command -v apt-get >/dev/null 2>&1; then
  # Debian / Ubuntu. Node 22 from NodeSource.
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gnupg \
    jq \
    procps \
    xz-utils
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y --no-install-recommends nodejs
  apt-get clean
  rm -rf /var/lib/apt/lists/*
elif command -v pacman >/dev/null 2>&1; then
  # Arch Linux. Rolling repos ship the current Node. Full upgrade because
  # Arch does not support partial upgrades (avoids keyring/signature breakage).
  # --disable-sandbox: pacman 7's download sandbox needs seccomp, which fails
  # under qemu emulation (amd64-on-arm64 local builds); pointless in an
  # ephemeral image build anyway.
  pacman -Syu --noconfirm --needed --disable-sandbox \
    ca-certificates \
    curl \
    git \
    jq \
    nodejs \
    npm \
    procps-ng \
    shadow \
    tar \
    xz
  pacman -Scc --noconfirm >/dev/null 2>&1 || true
  rm -rf /var/cache/pacman/pkg/*
else
  echo "Unsupported base image: no apk, apt-get or pacman found" >&2
  exit 1
fi

node --version
npm --version
