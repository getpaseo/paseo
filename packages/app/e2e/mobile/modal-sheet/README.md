# Native sheet gestures

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

## Recorded verification

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
