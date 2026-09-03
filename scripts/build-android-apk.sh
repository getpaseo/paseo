set -euo pipefail

usage() {
  cat <<'EOF'
Build Paseo's production Android APK with the Nix-provided Android toolchain.

Usage:
  nix run .#android-release -- [options] [-- GRADLE_ARG...]

Options:
  --architecture ABI  Build one of: armeabi-v7a, arm64-v8a, x86, x86_64
  --fdroid            Enable Paseo's source-only F-Droid build profile
  --output DIR        Copy APKs to DIR (default: result/android). Existing
                      *.apk files directly in DIR are removed first so the
                      directory only describes the build that just ran.
  -h, --help          Show this help

The command expects JavaScript dependencies to have been installed with
`npm ci`. APP_VARIANT, PASEO_FDROID_BUILD, and PASEO_ANDROID_OUTPUT_DIR can
also be supplied through the environment.
EOF
}

repo="${PASEO_ROOT:-$PWD}"
architecture="${PASEO_ANDROID_ARCHITECTURE:-}"
fdroid_build="${PASEO_FDROID_BUILD:-0}"
output_dir="${PASEO_ANDROID_OUTPUT_DIR:-result/android}"
gradle_args=()

while (($# > 0)); do
  case "$1" in
    --architecture)
      if (($# < 2)); then
        echo "--architecture requires an ABI" >&2
        exit 2
      fi
      architecture="$2"
      shift 2
      ;;
    --fdroid)
      fdroid_build=1
      shift
      ;;
    --output)
      if (($# < 2)); then
        echo "--output requires a directory" >&2
        exit 2
      fi
      output_dir="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      gradle_args=("$@")
      break
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$architecture" in
  "" | armeabi-v7a | arm64-v8a | x86 | x86_64) ;;
  *)
    echo "Unsupported Android architecture: $architecture" >&2
    exit 2
    ;;
esac

case "$fdroid_build" in
  0 | 1) ;;
  *)
    echo "PASEO_FDROID_BUILD must be 0 or 1" >&2
    exit 2
    ;;
esac

cd "$repo"

if [[ ! -f package.json || ! -f packages/app/package.json ]]; then
  echo "Run this command from the Paseo repository root, or set PASEO_ROOT." >&2
  exit 1
fi

if [[ ! -x node_modules/.bin/expo ]]; then
  echo "JavaScript dependencies are missing. Run npm ci first." >&2
  exit 1
fi

app_variant="${APP_VARIANT:-production}"

npm run build:app-deps
npm --prefix packages/app run build:terminal-webview

(
  cd packages/app
  CI=1 \
    APP_VARIANT="$app_variant" \
    PASEO_FDROID_BUILD="$fdroid_build" \
    npx --no-install expo prebuild --platform android --clean

  cd android

  build_args=(
    assembleRelease
    --no-daemon
    --console plain
    --max-workers=1
    -Dorg.gradle.parallel=false
  )

  if [[ -n "$architecture" ]]; then
    build_args+=("-PreactNativeArchitectures=$architecture")
  fi

  APP_VARIANT="$app_variant" \
    PASEO_FDROID_BUILD="$fdroid_build" \
    ./gradlew "${build_args[@]}" "${gradle_args[@]}"
)

artifact_dir="packages/app/android/app/build/outputs/apk/release"
mapfile -d '' apks < <(find "$artifact_dir" -maxdepth 1 -type f -name '*.apk' -print0)

if ((${#apks[@]} == 0)); then
  echo "No release APKs were produced in $artifact_dir" >&2
  exit 1
fi

mkdir -p "$output_dir"

artifact_dir_path="$(cd "$artifact_dir" && pwd -P)"
output_dir_path="$(cd "$output_dir" && pwd -P)"

if [[ "$output_dir_path" == "$artifact_dir_path" ]]; then
  # The caller pointed --output at Gradle's own output directory, so the APKs
  # are already in place. Never prune here: these are the files we just built.
  for apk in "${apks[@]}"; do
    echo "$apk"
  done
  exit 0
fi

# Reusing an output directory across builds that differ in architecture or
# variant otherwise leaves the previous run's APKs sitting next to the current
# ones, making the artifact set ambiguous. Prune only *.apk files directly in
# the directory so unrelated files a caller keeps there are left alone.
find "$output_dir_path" -maxdepth 1 -type f -name '*.apk' -delete

for apk in "${apks[@]}"; do
  destination="$output_dir_path/$(basename "$apk")"
  cp "$apk" "$destination"
  echo "$destination"
done
