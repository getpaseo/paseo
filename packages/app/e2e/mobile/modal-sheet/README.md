# Native modal and sheet gestures

## Compact sheet gestures

Use an Android emulator at 1080×1920, density 420, with the checkout's native app bundle loaded.
Connect the app to an isolated daemon, enable plugins, and install `plugin-examples/modal-ui` there.
Set `SHEET_QA_SERVER_ID` to that host's server ID, then run from the repository root:

```sh
agent-device test packages/app/e2e/mobile/modal-sheet/gestures.android.ad \
  --env EXAMPLES_URL="paseo://h/${SHEET_QA_SERVER_ID}/plugin/modal-ui-example/surface/main" \
  --record-video --artifacts-dir .dev/sheet-qa/plugin

agent-device test packages/app/e2e/mobile/modal-sheet/model.android.ad \
  --env FORM_URL="paseo://new?serverId=${SHEET_QA_SERVER_ID}" \
  --record-video --artifacts-dir .dev/sheet-qa/model
```

The plugin journey checks body dismissal, reopening, expansion and last-row reachability with SDK
ScrollView and FlatList, programmatic scrolling after expansion, downward list scrolling, and
horizontal tab selection. The model journey checks body dismissal and the nested sheet's return to
its parent without selecting a model or submitting a prompt. It does not assert catalog contents.

These scripts live outside the default mobile suite because they require the installed example and
an explicit connected host. See [mobile testing](../../../../../docs/mobile-testing.md) for device setup.

### Recorded verification

Android API 35, 1080×1920 at density 420, development binary 0.7.2 with this checkout's JavaScript.
Plugin tests used an isolated daemon. Recordings show the same body drag
[before](evidence/android-before.mp4) and [after](evidence/android-after.mp4) the fix.
The [browser recording](evidence/browser.webm) covers the existing plugin modal journey at wide and
compact sizes.

```text
Baseline dismissal regression:
failed at step 6: wait timed out for selector: label="Open ScrollView"
Current surface: Bottom sheet handle, Bottom Sheet, Close, Row 1.

Fixed dismissal regression: 1 passed (6.47s)
Full plugin gesture journey: 1 passed (44.3s)
Model sheet dismissal/reopen journey: 1 passed (13.7s)
Browser plugin-modal-body.spec.ts: 1 passed (33.4s)
Root typecheck, lint and format: passed
```

The model form's catalog stayed on “Loading…” in the debug app even though the isolated daemon's
provider API returned models. Its sheet dismissal/reopen was exercised; populated model selection
was not. iOS and Electron were not exercised.

## Tablet model selection

`model-tablet.android.ad` exercises the New workspace popover. `model-tablet-agent.android.ad`
exercises the modal used by an existing agent's narrow composer on a wide device. Both drill into
a populated provider, select a real model, assert the updated trigger, reopen, and dismiss with
Android Back. New workspace also pans beyond the short list viewport and flings back without
selecting a row or dismissing the popover. They do not submit a prompt.

Use an English-language Android tablet at 1600×2560, density 320 (800dp), with this checkout's
JavaScript and a connected isolated daemon. On a Pixel Tablet AVD, rotate to portrait explicitly;
its natural landscape orientation letterboxes this portrait-locked app into the compact layout:

```sh
adb -s "$ANDROID_SERIAL" shell settings put system accelerometer_rotation 0
adb -s "$ANDROID_SERIAL" shell settings put system user_rotation 1
adb -s "$ANDROID_SERIAL" shell wm density 320
```

Prepare an idle agent through the daemon's public `createAgent` API with a real provider/model and
no initial prompt. Set `MODEL_QA_AGENT_ID` and `MODEL_QA_AGENT_TITLE` to that agent. In New workspace,
remember a model first (the phone layout works on the broken baseline), then close the picker.
Choose a model visible on the provider's first page and set its catalog ID and displayed label.
Set `MODEL_QA_LAST_MODEL_ID` to its initially offscreen last model; use a short overflowing catalog
(six rows during this verification) for the coordinate-based pan/fling regression:

```sh
agent-device test packages/app/e2e/mobile/modal-sheet/model-tablet.android.ad \
  packages/app/e2e/mobile/modal-sheet/model-tablet-agent.android.ad \
  --serial "$ANDROID_SERIAL" --metro-port "$MODEL_QA_METRO_PORT" \
  --env FORM_URL="paseo://new?serverId=${SHEET_QA_SERVER_ID}" \
  --env AGENT_URL="paseo://h/${SHEET_QA_SERVER_ID}/agent/${MODEL_QA_AGENT_ID}" \
  --env AGENT_TITLE="$MODEL_QA_AGENT_TITLE" \
  --env PROVIDER_ID=codex --env MODEL_ID="$MODEL_QA_MODEL_ID" \
  --env MODEL_LABEL="$MODEL_QA_MODEL_LABEL" --env LAST_MODEL_ID="$MODEL_QA_LAST_MODEL_ID" \
  --artifacts-dir /tmp/paseo-model-tablet-qa
```

The existing-agent journey needs the sidebar pinned so its composer stays narrow. Start each run with no modal open;
a failed provider tap leaves its modal open, so dismiss it before the next run. These host-dependent
journeys remain outside the default mobile suite, alongside the compact sheet journeys above.

Keep generated screenshots, recordings, and run logs outside the repository.
