# syntax=docker/dockerfile:1
#
# Paseo daemon base image.
#
# One Dockerfile, many distros: pass --build-arg BASE_IMAGE=<image>.
# Supported families: Debian/Ubuntu (apt) and Alpine (apk).
#
#   docker build --build-arg BASE_IMAGE=debian:13-slim -t paseo:debian docker/base
#   docker build --build-arg BASE_IMAGE=ubuntu:24.04   -t paseo:ubuntu docker/base
#   docker build --build-arg BASE_IMAGE=alpine:3.21    -t paseo:alpine docker/base
#
ARG BASE_IMAGE=debian:13-slim
FROM ${BASE_IMAGE}

# TARGETARCH is provided automatically by buildx (amd64 / arm64).
ARG TARGETARCH
ARG S6_OVERLAY_VERSION=3.2.0.2
# Paseo version to install from npm. Defaults to latest; CI pins to the release version.
ARG PASEO_VERSION=latest

ENV PASEO_HOME=/home/paseo \
    HOME=/home/paseo \
    PASEO_LISTEN=0.0.0.0:6767 \
    CLAUDE_CONFIG_DIR=/home/paseo/.claude \
    CODEX_HOME=/home/paseo/.codex \
    XDG_CONFIG_HOME=/home/paseo/.config \
    XDG_DATA_HOME=/home/paseo/.local/share \
    XDG_STATE_HOME=/home/paseo/.local/state \
    XDG_CACHE_HOME=/home/paseo/.cache \
    ONNXRUNTIME_NODE_INSTALL=skip \
    PUID=911 \
    PGID=911 \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0 \
    S6_VERBOSITY=1

# Base runtime deps + Node 22 (family-detected inside the script).
COPY scripts/install-base.sh /tmp/install-base.sh
RUN /tmp/install-base.sh && rm -f /tmp/install-base.sh

# s6-overlay v3 (process supervisor + PID 1).
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) S6_ARCH=x86_64 ;; \
      arm64) S6_ARCH=aarch64 ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    curl -fsSL -o s6-noarch.tar.xz \
      "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz"; \
    curl -fsSL -o s6-arch.tar.xz \
      "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_ARCH}.tar.xz"; \
    tar -C / -Jxpf s6-noarch.tar.xz; \
    tar -C / -Jxpf s6-arch.tar.xz; \
    rm -f s6-noarch.tar.xz s6-arch.tar.xz

# Paseo server + CLI from npm. On Alpine this compiles node-pty against musl
# using a throwaway toolchain that the script removes afterwards.
COPY scripts/install-paseo.sh /tmp/install-paseo.sh
RUN PASEO_VERSION="${PASEO_VERSION}" /tmp/install-paseo.sh && rm -f /tmp/install-paseo.sh

# Non-root runtime user. IDs are re-mapped at boot from PUID/PGID.
RUN set -eux; \
    if [ -f /etc/alpine-release ]; then \
      addgroup -g 911 paseo; \
      adduser -D -H -h /home/paseo -u 911 -G paseo -s /bin/bash paseo; \
    else \
      groupadd -g 911 paseo; \
      useradd -u 911 -g paseo -d /home/paseo -M -s /bin/bash paseo; \
    fi; \
    paseo_shell="$(awk -F: '$1 == "paseo" { print $7 }' /etc/passwd)"; \
    [ "$paseo_shell" = "/bin/bash" ]

# s6 service definitions, the docker-mods loader and the daemon launcher.
COPY rootfs/ /

RUN set -eux; \
    chmod +x \
      /usr/local/bin/docker-mods \
      /usr/local/bin/paseo-run \
      /etc/s6-overlay/s6-rc.d/init-paseo/run \
      /etc/s6-overlay/s6-rc.d/init-docker-mods/run \
      /etc/s6-overlay/s6-rc.d/svc-paseo/run \
      /etc/s6-overlay/s6-rc.d/svc-paseo-pair/run

EXPOSE 6767
VOLUME /home/paseo

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('net').connect(6767,'127.0.0.1').on('connect',function(){process.exit(0)}).on('error',function(){process.exit(1)})" || exit 1

ENTRYPOINT ["/init"]
