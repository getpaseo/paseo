# Maestro Flows

This directory contains local mobile UI flows. Keep flows small enough that a
failure screenshot proves the intended behavior, not just that the app launched.

## iOS Sidebar Close Regression

`ios-sidebar-close-regression.yaml` exercises close swipes over a semantic header
and the nested workspace list without activating the content below the swipe.
Start the `sh.paseo.debug` dev client against the intended Metro server first;
the flow preserves that running connection.

```bash
maestro test packages/app/maestro/ios-sidebar-close-regression.yaml --udid <simulator-udid>
```

## iOS Sidebar Drag Cancellation Regression

`test-sidebar-drag-cancellation-ios.sh` creates three temporary projects and
uses real native slow swipes to cover successful reorder, a second touch during
the drop spring, horizontal close cancellation, outer-list scroll recovery, and
a subsequent reorder. The harness removes its daemon projects and local fixture
directories on exit.

Start the debug dev client against the intended Metro server, then run:

```bash
bash packages/app/maestro/test-sidebar-drag-cancellation-ios.sh
```

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

## Goals

The `goals-*.yaml` flows cover the Goals screen on a phone. They do not launch
the app: start the `sh.paseo.debug` dev client connected to a host with Goals,
at least one git project, and a provider. `flows/goals-open.yaml` opens Goals
from the sidebar.

| Flow                       | Needs                                                | Covers                                                                                                                 |
| -------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `goals-create.yaml`        |                                                      | Create a managed goal: Ask me is the default policy, type and drag Max parallel, comma decimal in the cost cap, submit |
| `goals-edit-settings.yaml` | `GOAL_ID` of a live managed goal                     | Edit settings from the detail menu, type and drag, save                                                                |
| `goals-row-menu.yaml`      | `GOAL_ID`                                            | Row kebab: rename and priority, without opening the row                                                                |
| `goals-usage.yaml`         | `GOAL_ID` with turns, host with `goalUsageBreakdown` | Expand and collapse Usage by role                                                                                      |
| `goals-android-back.yaml`  | `GOAL_ID`, Android                                   | Back closes the sheet, then returns to the list                                                                        |

```bash
maestro test packages/app/maestro/goals-create.yaml
maestro test -e GOAL_ID=<goal-id> packages/app/maestro/goals-edit-settings.yaml
```

What a script cannot judge (keyboard placement, haptics, screen readers) is in
[the Goals native checks](../../../docs/goals.md#native-checks).
