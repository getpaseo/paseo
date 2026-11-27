#!/usr/bin/env bash
set -euo pipefail

# Verifies that the Add project bottom sheet footer never flashes behind the Android system
# navigation bar on keyboard dismiss or overshoots upward on keyboard open.
#
# Prerequisites (configured on the test device before running):
# - Three-button navigation bar enabled (for example:
#   `adb shell cmd overlay enable com.android.internal.systemui.navbar.threebutton`).
# - Software keyboard enabled when a hardware keyboard is attached (`show_ime_with_hard_keyboard=1`)
#   and a visible soft keyboard (such as Gboard) selected as the active IME.
# - The Add project sheet already open with a connected host so the Open project footer button is
#   visible.
# - `ffmpeg` and `ffprobe` on PATH.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERIAL="${ANDROID_SERIAL:-$(adb devices | awk '/\tdevice$/ {print $1; exit}')}"
OUT_DIR="${SHEET_FOOTER_QA_DIR:-/tmp/paseo-sheet-footer-qa}"
VIDEO_PATH="$OUT_DIR/sheet-footer-keyboard.mp4"

if [ -z "$SERIAL" ]; then
  echo "No Android device attached. Set ANDROID_SERIAL or start an emulator." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

# Derive tap coordinates and 3-button navigation bar height (48dp) from the active display metrics.
SIZE_LINE="$(adb -s "$SERIAL" shell wm size | tail -n 1 | tr -d '\r')"
DIMENSIONS="${SIZE_LINE##* }"
WIDTH="${DIMENSIONS%x*}"
HEIGHT="${DIMENSIONS#*x}"
DENSITY_LINE="$(adb -s "$SERIAL" shell wm density | tail -n 1 | tr -d '\r')"
DENSITY="${DENSITY_LINE##* }"
NAV_BAR_PX="${SHEET_FOOTER_NAV_BAR_PX:-$((48 * DENSITY / 160))}"
SEARCH_X=$((WIDTH / 2))
SEARCH_Y=$((HEIGHT * 34 / 100))

adb -s "$SERIAL" shell rm -f /sdcard/sheet-footer-keyboard.mp4
adb -s "$SERIAL" shell screenrecord --time-limit 9 --bit-rate 8000000 /sdcard/sheet-footer-keyboard.mp4 &
REC_PID=$!

sleep 0.8
adb -s "$SERIAL" shell input tap "$SEARCH_X" "$SEARCH_Y"
sleep 1.8
adb -s "$SERIAL" shell input keyevent 4
sleep 1.8
adb -s "$SERIAL" shell input tap "$SEARCH_X" "$SEARCH_Y"
sleep 1.8
adb -s "$SERIAL" shell input keyevent 4
wait "$REC_PID" || true

adb -s "$SERIAL" pull /sdcard/sheet-footer-keyboard.mp4 "$VIDEO_PATH" >/dev/null
node "$SCRIPT_DIR/assert-sheet-footer-keyboard.mjs" "$VIDEO_PATH" 4 "$NAV_BAR_PX"
