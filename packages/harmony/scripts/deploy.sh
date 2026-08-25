#!/usr/bin/env bash
#
# deploy.sh — Build, sign, install, and launch Paseo on a connected device.
#
# Prerequisites:
#   - hdc available at $HDC or auto-detected from SDK
#   - hap-sign-tool.jar available at $HAP_TOOL or auto-detected from SDK
#   - Device connected via USB (hdc list targets shows a device)
#
# Usage:
#   PASEO_KEY_PASSWORD=<keystore-password> bash scripts/deploy.sh
#
# The script auto-detects the connected device. If multiple devices are
# connected, set PASEO_DEVICE to the target serial.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HARMONY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$HARMONY_DIR/../.." && pwd)"
SDK_BASE="/mnt/coder/Service/command-line-tools/sdk/default/openharmony"
HVIGORW="/mnt/coder/Service/command-line-tools/bin/hvigorw"

# ---- signing materials ----
SIGN_DIR="$HARMONY_DIR/sign"
PASSWORD="${PASEO_KEY_PASSWORD:?must be set to the keystore password}"
KEYSTORE_FILE="$SIGN_DIR/develop.p12"
KEY_ALIAS="paseo"
APP_CERT="$SIGN_DIR/paseo.cer"
PROFILE="$SIGN_DIR/paseoDebug.p7b"
SIGN_ALG="SHA256withECDSA"
BUNDLE_NAME="com.yixuanju.paseo"
COMPAT_VERSION="12"

# ---- tools ----
HDC="${HDC:-$SDK_BASE/toolchains/hdc}"
HAP_TOOL="${HAP_TOOL:-$SDK_BASE/toolchains/lib/hap-sign-tool.jar}"

# ---- build output paths ----
BUILD_DIR="$HARMONY_DIR/entry/build/default/outputs/default"
UNSIGNED_HAP="$BUILD_DIR/entry-default-unsigned.hap"
SIGNED_HAP="$BUILD_DIR/entry-default-signed.hap"

# ---- helpers ----
log()  { echo "[deploy] $*"; }
err()  { echo "[deploy] ERROR: $*" >&2; exit 1; }

# ---- detect device ----
DEVICE="${PASEO_DEVICE:-$($HDC list targets 2>/dev/null | head -1)}"
if [ -z "$DEVICE" ]; then
  err "No device found. Connect a device via USB and try again."
fi
log "Target device: $DEVICE"

# ---- build ----
log "Building..."
cd "$HARMONY_DIR"
$HVIGORW assembleHap --no-daemon -p buildMode=debug || err "Build failed"

# ---- sign ----
log "Signing..."
java -jar "$HAP_TOOL" sign-app \
  -mode localSign \
  -keyAlias "$KEY_ALIAS" \
  -keyPwd "$PASSWORD" \
  -appCertFile "$APP_CERT" \
  -profileFile "$PROFILE" \
  -inFile "$UNSIGNED_HAP" \
  -signAlg "$SIGN_ALG" \
  -keystoreFile "$KEYSTORE_FILE" \
  -keystorePwd "$PASSWORD" \
  -outFile "$SIGNED_HAP" \
  -compatibleVersion "$COMPAT_VERSION" \
  -pwdInputMode 0 || err "Signing failed"

# ---- install ----
log "Installing..."
$HDC -t "$DEVICE" install "$SIGNED_HAP" || err "Install failed"

# ---- launch ----
log "Launching..."
$HDC -t "$DEVICE" shell "aa start -a EntryAbility -b $BUNDLE_NAME" || err "Launch failed"

log "Done! App is running on $DEVICE"
