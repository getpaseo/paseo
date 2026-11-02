# Late composer pill clearance

This regression opens a completed conversation, relaunches the Android app, and
registers a composer pill five seconds after the client plugin loads. It checks
that the completed turn's Copy and Fork buttons remain fully above the pill.
The daemon, plugin API, native app, layout, and accessibility bounds are real;
no provider calls are needed during the test.

Prerequisites:

- Build the server and app dependencies with `npm run build:server` and
  `npm run build --workspace=@getpaseo/expo-two-way-audio`.
- Run an isolated development daemon on a non-default port.
- Run this checkout's Metro server and open the connected Android dev client
  with `agent-device`. The app must already know the isolated daemon.
- Open a completed conversation on a compact portrait Android emulator, at the
  latest turn, with no other composer tracks visible. Keep the software keyboard
  closed. Note the workspace and agent IDs from the daemon.

Set `WORKSPACE_ID` and `AGENT_ID` to that conversation, then run from the
repository root, substituting the session and ports:

```sh
PASEO_OVERLAY_ARTIFACTS_DIR=.dev/composer-overlay-evidence \
  node packages/app/e2e/mobile/composer-overlay/android.mjs \
  composer-overlay ws://127.0.0.1:6843/ws "$WORKSPACE_ID" "$AGENT_ID" sh.paseo.debug 8193
```

The runner installs and removes its delayed plugin and leaves the conversation
intact. It preserves the daemon's previous plugins-enabled setting. The evidence directory
contains the cold-reopen screenshot and raw accessibility snapshot. Without an
explicit directory, temporary evidence is removed with the fixture.

To check an existing capture independently:

```sh
node packages/app/e2e/mobile/composer-overlay/assert-footer-clear.mjs \
  .dev/composer-overlay-evidence/cold-reopen.json 'Overlay regression pill'
```

On the failing baseline, the Copy button extends below the pill's top edge. With
the correction, both actions are clear before the composer receives focus.

Additional checks on the same conversation: opening the keyboard keeps the footer
clear; after scrolling up, a newly registered pill must not jump back to the latest
turn. Native iOS uses a different keyboard implementation and needs its own device
verification.
