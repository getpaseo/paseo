# Maestro Flows

This directory contains local mobile UI flows. Keep flows small enough that a
failure screenshot proves the intended behavior, not just that the app launched.

## New Workspace Android Flow

Use these files when debugging or extending workspace creation on Android:

- `test-workspace-create-android-crash.sh` runs the full regression harness.
- `workspace-create-android-crash.yaml` is the full Maestro flow used by the
  harness.
- `record-workspace-create-android-focus.sh` records only the focused repro
  window after setup.
- `workspace-create-android-ready-sidebar.yaml` stages the app with the Android
  sidebar open and a prepared project visible.
- `workspace-create-android-create-focused.yaml` starts from that staged sidebar
  and performs the actual workspace creation.

The reusable pieces live in `flows/`:

- `flows/android-dev-client.yaml` handles Expo dev launcher/dev menu screens.
- `flows/connect-direct-if-welcome.yaml` connects to the local daemon only when
  the welcome screen is visible.
- `flows/open-prepared-project-sidebar.yaml` waits for the home screen, opens
  the compact Android sidebar, and waits for the prepared project.
- `flows/new-workspace-open-from-sidebar.yaml` taps the project row's
  new-workspace action and waits for `/new`.
- `flows/new-workspace-select-codex-gpt54.yaml` selects a real provider/model.
- `flows/new-workspace-submit-and-assert-created.yaml` taps `Create` and proves
  the app landed on the created workspace.

Compose new workspace scenarios out of these primitives instead of copying the
old full flow. The shell scripts render the top-level flows and every `flows/*.yaml`
file into the same temp directory, so nested `runFlow: flows/...` paths keep
working with `${PASEO_MAESTRO_*}` placeholders.

The flow is intentionally strict. It must:

1. Open a prepared project from the daemon.
2. Tap the project row's new-workspace action.
3. Select an actual provider/model before tapping `Create`.
4. Tap `Create`.
5. Assert the app lands on a workspace header and the draft composer.
6. Assert `New workspace`, `Select a model`, and the Android redbox text are not
   visible.
7. For the shell harness, grep logcat for `failed to insert view` and
   `specified child already has a parent`.

Do not weaken this flow to only wait for `message-input-root`. That can pass on
the wrong route. The header assertion and the `New workspace` negative assertion
are what prove the redirect actually completed.

The scripts assume a development build with package id `sh.paseo.debug`, an
already-running local daemon on `127.0.0.1:6767`, and a connected Android device
or emulator. They call `adb reverse tcp:6767 tcp:6767`; they do not restart the
daemon.

```bash
bash packages/app/maestro/test-workspace-create-android-crash.sh
bash packages/app/maestro/record-workspace-create-android-focus.sh
```

Optional environment:

```bash
PASEO_MAESTRO_APP_ID=sh.paseo.debug
PASEO_MAESTRO_DIRECT_ENDPOINT=127.0.0.1:6767
PASEO_MAESTRO_DAEMON_WS_URL=ws://127.0.0.1:6767/ws
PASEO_MAESTRO_PROJECT_PATH=/path/to/git/repo
```
