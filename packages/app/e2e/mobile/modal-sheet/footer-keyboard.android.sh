#!/usr/bin/env bash
set -euo pipefail

# Verifies that the Add project bottom sheet footer never flashes behind the Android system
# navigation bar on keyboard dismiss or overshoots upward on keyboard open.
#
# Prerequisites:
# - An Android emulator or device with the Add project sheet already open (with a connected host so
#   the Open project footer button is visible) and Gboard installed.
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

adb -s "$SERIAL" shell cmd overlay enable com.android.internal.systemui.navbar.threebutton >/dev/null
adb -s "$SERIAL" shell settings put secure show_ime_with_hard_keyboard 1
adb -s "$SERIAL" shell ime set com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME >/dev/null

# Derive tap coordinates from the device's active display size.
SIZE_LINE="$(adb -s "$SERIAL" shell wm size | tail -n 1 | tr -d '\r')"
DIMENSIONS="${SIZE_LINE##* }"
WIDTH="${DIMENSIONS%x*}"
HEIGHT="${DIMENSIONS#*x}"
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
node "$SCRIPT_DIR/assert-sheet-footer-keyboard.mjs" "$VIDEO_PATH"
