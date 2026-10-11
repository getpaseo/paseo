#!/usr/bin/env bash
set -euo pipefail
TASK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$TASK_ROOT"
npm run build:enhanced-icons
: "${ANDROID_HOME:?Set ANDROID_HOME to an installed Android SDK}"
: "${JAVA_HOME:?Set JAVA_HOME to a compatible JDK (local build verified with JDK 17)}"
export APP_VARIANT=enhanced CI=1 NODE_ENV=production
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$TASK_ROOT/.dev/gradle}"
npm run build:app-deps
npm run build:pdf-runtime --workspace=@getpaseo/app
(cd packages/app && npx expo prebuild --platform android --no-install)
gradle_args=(:app:assembleRelease -PreactNativeArchitectures=arm64-v8a --no-daemon --max-workers=2)
if [[ -n "${PASEO_ANDROID_GRADLE_INIT_SCRIPT:-}" ]]; then
  gradle_args+=(-I "$PASEO_ANDROID_GRADLE_INIT_SCRIPT")
fi
(cd packages/app/android && ./gradlew "${gradle_args[@]}")
version="$(node -p "require('./packages/app/package.json').version")"
output="$TASK_ROOT/artifacts/enhanced/Paseo-Enhanced-$version-android-arm64.apk"
mkdir -p "$(dirname "$output")"
cp packages/app/android/app/build/outputs/apk/release/app-release.apk "$output"
node scripts/verify-enhanced-android.mjs "$output"
echo "Android local preview: $output"
