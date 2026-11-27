# Android Usage drop regressions

Use a device you own and fixed reports from an isolated daemon. Keep recordings in `.artifacts/`. Do not upload recordings containing account details.

## Same-slot drop

Open Usage with two cards that fit without scrolling. Run:

```sh
ANDROID_SERIAL=emulator-5580 node packages/app/e2e/mobile/usage-drag/android.mjs
```

Set `PASEO_DEVICE_SESSION` to reuse your Agent Device session. The test holds the first handle, moves within its slot, drops it, then swipes the sheet body. It asserts sheet movement while the finger is still down: after release, the sheet can snap back to its starting position.

## Old-order frame

Record a drop with Android `screenrecord`. Include the original order, the held arrangement, the release, and at least five seconds after release. Take a reference screenshot before recording. Use fixed labels that stay visible throughout the drop.

Create a JSON map of label names to screenshot rectangles `[x, y, width, height]`, in physical pixels. Crop each label tightly, without changing text or the pointer. Install `opencv-python-headless` in a local virtual environment under `.artifacts/`, then run:

```sh
.artifacts/frames-venv/bin/python packages/app/e2e/mobile/usage-drag/frames.py \
  --reference .artifacts/before.png --labels .artifacts/labels.json \
  .artifacts/drop-up.mp4 .artifacts/drop-down.mp4
```

The check requires recognized labels in the first and last frames and a changed final order. After every label first reaches its final slot, it fails on any frame showing all original slots again. It prints the offending frame numbers for each recording. This exercises the Android compositor; a JavaScript render test cannot establish which intermediate commit reached the screen.
