#!/bin/sh
# Install base runtime dependencies + Node.js 22.
# Detects the package manager (apt vs apk) so one script covers all distros.
set -eu

install_node_tarball() {
  case "$(uname -m)" in
    x86_64) node_arch=x64 ;;
    aarch64) node_arch=arm64 ;;
    *)
      echo "Unsupported Node.js architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac

  node_dist_url="${NODE_DIST_URL:-https://nodejs.org/dist/latest-v22.x}"
  node_tmp="$(mktemp -d)"
  sums_file="${node_tmp}/SHASUMS256.txt"

  curl -fsSL "${node_dist_url}/SHASUMS256.txt" -o "${sums_file}"
  node_archive="$(
    sed -n "s/^.*  \(node-v.*-linux-${node_arch}\.tar\.xz\)$/\1/p" "${sums_file}" | head -n 1
  )"

  if [ -z "${node_archive}" ]; then
    echo "Could not find Node.js linux-${node_arch} archive in ${node_dist_url}" >&2
    exit 1
  fi

  curl -fsSL "${node_dist_url}/${node_archive}" -o "${node_tmp}/${node_archive}"
  (cd "${node_tmp}" && grep "  ${node_archive}$" SHASUMS256.txt | sha256sum -c -)
  tar -C /usr/local --strip-components=1 -xJf "${node_tmp}/${node_archive}"
  rm -rf "${node_tmp}"
}

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
    sudo \
    tar \
    tini \
    xz
elif command -v apt-get >/dev/null 2>&1; then
  # Debian / Ubuntu. Install Node from the official tarball instead of the
  # NodeSource .deb: arm64 apt package triggers have been flaky under QEMU in
  # GitHub Actions multi-arch builds.
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gnupg \
    jq \
    procps \
    sudo \
    xz-utils
  install_node_tarball
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
    sudo \
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
