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
else
  echo "Unsupported base image: no apk or apt-get found" >&2
  exit 1
fi

node --version
npm --version
