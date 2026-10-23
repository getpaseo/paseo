#!/usr/bin/env bash
# Local Android build for Pyrgos Paseo: no EAS cloud, no signing secrets.
# Usage: scripts/pyrgos/build-android.sh [debug|production|both]   (default: both)
# Env (all optional): JAVA_HOME (JDK 17-21), ANDROID_HOME, PYRGOS_APK_OUT (default <repo>/artifacts/pyrgos),
#   PYRGOS_ABIS (default arm64-v8a; "all" = armeabi-v7a,arm64-v8a,x86,x86_64),
#   EXPO_PUBLIC_LOCAL_DAEMON (daemon endpoint baked into the JS bundle).
set -euo pipefail

target="${1:-both}"
case "$target" in debug|production|both) ;; *) echo "usage: $0 [debug|production|both]" >&2; exit 2 ;; esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
app="$root/packages/app"
out="${PYRGOS_APK_OUT:-$root/artifacts/pyrgos}"

# JDK: Gradle/React Native need 17-21; Android Studio's bundled JBR may be newer.
if [ -z "${JAVA_HOME:-}" ] || ! "$JAVA_HOME/bin/java" -version 2>&1 | grep -qE 'version "(17|18|19|20|21)\.'; then
  for j in "$HOME"/.local/jdk/jdk-21* /usr/lib/jvm/*21* /usr/lib/jvm/*17*; do
    [ -x "$j/bin/java" ] && { export JAVA_HOME="$j"; break; }
  done
fi
[ -x "${JAVA_HOME:-/nonexistent}/bin/java" ] || { echo "No JDK 17-21 found; set JAVA_HOME (see docs/pyrgos/BUILD.md)." >&2; exit 1; }
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
[ -d "$ANDROID_HOME/platforms" ] || { echo "Android SDK not found at ANDROID_HOME=$ANDROID_HOME (see docs/pyrgos/BUILD.md)." >&2; exit 1; }
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

abis="${PYRGOS_ABIS:-arm64-v8a}"
[ "$abis" = all ] && abis="armeabi-v7a,arm64-v8a,x86,x86_64"

# Debug keystore for release signing: generated once, never committed, not a secret.
ks="${PYRGOS_DEBUG_KEYSTORE:-$HOME/.android/debug.keystore}"
if [ ! -f "$ks" ]; then
  mkdir -p "$(dirname "$ks")"
  keytool -genkeypair -keystore "$ks" -storepass android -keypass android -alias androiddebugkey \
    -dname "CN=Android Debug,O=Android,C=US" -keyalg RSA -keysize 2048 -validity 10000 >/dev/null
fi

mkdir -p "$out"
out="$(cd "$out" && pwd)"
cd "$root"
# npm blocks these native-asset postinstalls (allowScripts); run them explicitly.
( cd "$app/node_modules/react-native-enriched-markdown" && node postinstall.mjs )
( cd "$app/node_modules/@shopify/react-native-skia" && node scripts/install-libs.js )
npm run build:app-deps
cd "$app"
export APP_VARIANT=production
npx expo prebuild --platform android --no-install
cd android

# Expo's template signs release with the debug keystore at android/app/debug.keystore.
cp "$ks" app/debug.keystore

gradle_args=(--no-daemon --max-workers=2 -Dorg.gradle.parallel=false "-PreactNativeArchitectures=$abis")
if [ "$target" = debug ] || [ "$target" = both ]; then
  ./gradlew assembleDebug "${gradle_args[@]}"
  cp app/build/outputs/apk/debug/app-debug.apk "$out/pyrgos-paseo-debug.apk"
fi
if [ "$target" = production ] || [ "$target" = both ]; then
  rm -rf app/build/generated/assets
  ./gradlew assembleRelease "${gradle_args[@]}"
  cp app/build/outputs/apk/release/app-release.apk "$out/pyrgos-paseo-production.apk"
fi

echo "APKs in $out:"
ls -l "$out"/*.apk
if command -v aapt2 >/dev/null 2>&1 || [ -d "$ANDROID_HOME/build-tools" ]; then
  aapt2="$(command -v aapt2 || ls "$ANDROID_HOME"/build-tools/*/aapt2 | tail -1)"
  for apk in "$out"/*.apk; do "$aapt2" dump badging "$apk" | grep -E '^package:|sdkVersion'; done
fi
