# Mobile Testing

## Agent Device

Agent Device `.ad` scripts are the primary mobile E2E format. An agent discovers a working flow interactively, saves the successful commands, then the replay runner executes the same typed plan locally or in CI.

Record a flow while driving the app normally:

```bash
agent-device open sh.paseo.debug \
  --platform ios \
  --session terminal-author \
  --save-script ./packages/app/e2e/mobile/agent-device/terminal.ios.ad
agent-device snapshot -i --session terminal-author
agent-device press 'id="workspace-header-menu-trigger"' --session terminal-author
# Continue the flow and verify its result with wait/get/is/find.
agent-device close --session terminal-author
```

`close` writes the script. Keep selectors based on stable app IDs. Keep assertions as `wait`, `get`, `is`, or `find` commands; screenshots are evidence, not assertions.

Run the Paseo mobile suite:

```bash
npm run test:e2e:mobile
```

The runner uses an isolated Agent Device state directory, verifies or starts Metro for this checkout, prewarms the iOS runner, discovers each script's platform from its `context` header, and cleans its sessions, runner lease, daemon, and any Metro process it started. Attempt results, timings, logs, and failure artifacts go under `.dev/agent-device-artifacts`.

Set `PASEO_MOBILE_E2E_METRO_PORT` when this worktree already has Metro on a non-default port:

```bash
PASEO_MOBILE_E2E_METRO_PORT=62093 npm run test:e2e:mobile
```

[native-terminal-basic.ios.ad](../packages/app/e2e/mobile/agent-device/native-terminal-basic.ios.ad) and [native-terminal-basic.android.ad](../packages/app/e2e/mobile/agent-device/native-terminal-basic.android.ad) are the smallest examples. Each opens a fresh terminal, types a command at zero delay, submits it, and asserts its distinct output. The app must be connected to a daemon with an active workspace.

For Android keyboard continuity, run the current checkout in the app, open an idle terminal
with an empty prompt, hide its keyboard, and run:

```bash
ANDROID_SERIAL=emulator-5554 node packages/app/e2e/mobile/terminal-keyboard/android.mjs
```

Use a real docked software keyboard. The harness taps Ctrl, Esc, and Enter and checks Android's
focused input identity and IME hide/show events. It saves screenshots and logs under
`.dev/agent-device-artifacts/terminal-keyboard-android`. Set `PASEO_TERMINAL_KEYBOARD_APP_ID=sh.paseo`
to test an installed production build. It never submits a chat message.

When replay diverges, read its ranked selector suggestions. Edit the script deliberately and rerun it from the beginning. `--update` is retained for compatibility but no longer rewrites scripts.

## Maestro compatibility

Existing Maestro flows live in `packages/app/maestro/`. Agent Device can execute its supported subset with `agent-device test <path> --maestro`, which provides a migration path while `.ad` coverage replaces these flows.

### Existing flows

Maestro flows live in `packages/app/maestro/`. Reusable sub-flows live in `packages/app/maestro/flows/`.

Run a flow:

```bash
maestro test packages/app/maestro/my-flow.yaml
```

### Screenshots

`takeScreenshot` writes to the **current working directory** — there's no way to configure the output path in the YAML. To keep screenshots out of the checkout, `cd` into a temp directory and use an absolute path for the flow:

```bash
FLOW="$(pwd)/packages/app/maestro/my-flow.yaml"
mkdir -p /tmp/maestro-out
cd /tmp/maestro-out && maestro test "$FLOW"
```

`packages/app/maestro/.gitignore` excludes `*.png` as a safety net.

### Element targeting

Use `testID` or `nativeID` on components, then target with `id:` in flows. Prefer this over text matching — text breaks on copy changes.

```tsx
// Component
<Pressable testID="sidebar-sessions" onPress={onPress}>
```

```yaml
# Flow
- tapOn:
    id: "sidebar-sessions"
- assertVisible:
    id: "sidebar-sessions"
```

### Conditional steps

Use `runFlow:when:visible` for steps that should only execute when a specific element is on screen:

```yaml
- runFlow:
    when:
      visible:
        id: "sidebar-sessions"
    commands:
      - swipe:
          direction: LEFT
          duration: 300
```

This is how `flows/dev-client.yaml` handles Expo dev client screens that only appear in dev builds.

### Don't use launchApp against a running dev app

`launchApp` kills and restarts the app, disrupting Expo dev client state and host connections. For flows that test against an already-running dev app, **omit launchApp entirely** — just interact with whatever is on screen.

Use `launchApp` only in flows that need a clean start (e.g., onboarding tests).

### Swipe gestures

Use `start`/`end` with percentage coordinates for precise control:

```yaml
# Edge swipe from left to open sidebar
- swipe:
    start: "5%,50%"
    end: "80%,50%"
    duration: 300
```

`direction: RIGHT` is simpler but less precise — use it for generic swipes, use coordinates when the start position matters (edge gestures, avoiding specific UI regions).

### Assertions

`assertVisible` checks **actual screen visibility**, not just view tree presence. An element that exists in the tree but is off-screen (e.g., `translateX: -400`) will correctly fail `assertVisible`. This makes it reliable for catching animation bugs where state says "open" but the view is visually hidden.

For async elements, use `extendedWaitUntil`:

```yaml
- extendedWaitUntil:
    visible: ".*Online.*"
    timeout: 90000
```

### Dev client handling

Two reusable flows handle Expo dev client screens after launch:

- `flows/launch.yaml` — handles dev launcher, dismisses dev menu, asserts "Welcome to Paseo"
- `flows/dev-client.yaml` — same but without asserting a particular app route

### Reach the composer

`flows/land-in-chat.yaml` is the canonical "get into a chat" primitive. It `clearState`s, runs `launch.yaml`, taps the welcome screen's direct-connection option, types `127.0.0.1:6767`, submits, and waits for `message-input-root`. Compose any composer-level fixture on top of it:

```yaml
appId: sh.paseo
---
- runFlow: flows/land-in-chat.yaml
# ...your scenario here, starting from a ready composer
```

See `image-picker-repro.yaml` for an example.

**Prefer direct connection over relay pairing for local E2E.** Relay needs a 400+ character pairing URL typed into an input; direct needs `127.0.0.1:6767`. The daemon listens on 6767 and the simulator can reach it directly.

### New Workspace Creation

The Android workspace-creation regression has a dedicated harness:

```bash
bash packages/app/maestro/test-workspace-create-android-crash.sh
```

For a short recording that starts after launch/connection/sidebar setup:

```bash
bash packages/app/maestro/record-workspace-create-android-focus.sh
```

The flow details are documented in `packages/app/maestro/README.md`. The important rule is that a valid new-workspace assertion must prove the redirect completed: select a real model, tap `Create`, wait for `workspace-header-title`, wait for `message-input-root`, assert `New workspace` is gone, and assert the Android redbox strings are absent. Waiting for the composer alone is too weak because it can still be the `/new` route after a validation error.

New workspace scenarios should compose the reusable subflows in `packages/app/maestro/flows/`:

- `android-dev-client.yaml`
- `connect-direct-if-welcome.yaml`
- `open-prepared-project-sidebar.yaml`
- `new-workspace-open-from-sidebar.yaml`
- `new-workspace-select-codex-gpt54.yaml`
- `new-workspace-submit-and-assert-created.yaml`

The workspace-create shell scripts render those subflows into a temp directory before running Maestro, which keeps nested `runFlow` paths and `${PASEO_MAESTRO_*}` placeholders working together.

### Inputs that Maestro types into

Maestro `inputText` fires one character at a time. React Native's **controlled** `TextInput` re-renders per keystroke; if a controlled input's state update lags or re-mounts mid-type, characters are dropped silently — the final value on screen is a truncated/scrambled version of what was "typed."

For inputs that E2E flows type into (host endpoint, pairing URL, etc.), use an **uncontrolled ref-backed input**: `defaultValue` + `onChangeText` writes into a `useRef`, reads via the ref on submit. No per-keystroke re-render, no dropped characters.

See `pair-link-modal.tsx` for the pattern (`useRef`-backed `onChangeText`, no `value=` prop). Always pair the source change with a Maestro `assertVisible` on the input's `id + text` after `inputText`, so regressions are caught immediately.

### Dropdowns that launch native presenters (iOS)

On iOS, when a dropdown menu (`DropdownMenu` / RN `Modal`) item needs to launch a native presenter like `PHPickerViewController` (image picker) or a `UIDocumentPicker`, the callback **must not fire while the `Modal` is still dismissing**. UIKit dismissal completion spans multiple frames beyond React unmount; launching a native presenter mid-dismissal leaves an invisible backdrop mounted that traps every subsequent touch.

`DropdownMenu` handles this by deferring the selected item's `onSelect` until `Modal.onDismiss` fires (UIKit-level dismissal complete), then adds a small extra buffer before invoking it. See `components/ui/dropdown-menu.tsx`'s `selectItem` / `flushPendingSelect`.

When building a new component that composes a dropdown with a native presenter, reuse this dropdown — do not invent a new timing shim.

## Self-verification loops

Maestro can only interact with the app UI — it can't toggle iOS appearance, change locale, or simulate network conditions. For bugs that depend on system-level state, wrap Maestro in a bash script that handles the system changes between Maestro runs.

This pattern also lets agents self-verify fixes without manual user testing.

### Pattern

1. Run baseline Maestro flow (confirm feature works)
2. Make system-level change via `xcrun simctl` (toggle appearance, etc.)
3. Re-run Maestro flow (confirm feature still works)
4. Repeat N iterations to catch intermittent failures

Scripts run `maestro test` from inside a temp directory so screenshots don't dirty the checkout.

See `packages/app/maestro/test-sidebar-theme.sh` for the canonical example:

```bash
bash packages/app/maestro/test-sidebar-theme.sh 6 1
# Args: iterations=6, wait_seconds=1 between toggle and test
```

Key elements of the script pattern:

```bash
set -euo pipefail
ITERATIONS="${1:-3}"

for i in $(seq 1 "$ITERATIONS"); do
  # Toggle system state
  xcrun simctl ui booted appearance light

  # Wait for change to propagate
  sleep 1

  # Run Maestro flow and capture result
  if maestro test "$FLOW" 2>&1 | tee "$ITER_DIR/test.log"; then
    echo "PASS"
  else
    echo "FAIL"
    xcrun simctl io booted screenshot "$ITER_DIR/failure-state.png"
  fi
done
```

### Android audio focus interruptions

Voice mode uses the custom `expo-two-way-audio` Android module, so incoming calls and other system audio owners must be tested with emulator/system commands, not a JS-only test. To verify that voice resume handles denied audio focus without crashing:

```bash
adb shell am start -n sh.paseo/.MainActivity
# Start voice mode in an existing composer, then background Paseo with Home.
adb emu gsm call 5551234
# Foreground Paseo while the call is still ringing.
```

Expected result: Paseo does not throw `RuntimeException: Audio focus request failed`; native audio reports an interruption and voice mode stops or pauses coherently.

### Releasing the audio session when idle

Paseo must not hold the OS audio session once it is neither capturing nor playing, or the user's
background music stays paused. On iOS this is not just a "while recording" problem: the
`.playAndRecord`/`.voiceChat` category is non-mixing and survives backgrounding, and iOS re-asserts
it every time the app returns to the foreground — so one dictation turn kills music for the life of
the process, on every open, until the app is force-quit. Android holds
`AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE` with the same effect. It must also reset
`MODE_IN_COMMUNICATION` and clear the selected communication device; abandoning focus alone can
leave Bluetooth earbuds on their narrow-band call route without an active microphone indicator.

`createAudioEngine` (`packages/app/src/voice/audio-engine.native.ts`) calls
`releaseAudioSession()` whenever capture stops and the playback queue drains, and the iOS module
also releases on `OnAppEntersBackground`. The native side re-guards on `isRecording` /
`speechPlayer.isPlaying`, because the native engine is a singleton shared by multiple JS engine
wrappers (voice provider + dictation) and only it knows the true state.

This cannot be validated by a JS test — verify on a device: play music through Bluetooth earbuds,
open Paseo, use dictation once, stop, and confirm the music resumes at full quality; then
background/foreground the app and confirm it keeps playing at full quality.

## Unistyles + Reanimated

### The crash

Applying Unistyles theme-reactive styles (`StyleSheet.create((theme) => ...)`) directly to `Animated.View` causes **"Unable to find node on an unmounted component"** on theme change.

Unistyles wraps styled components in `<UnistylesComponent>` and patches native view properties via C++. Reanimated also manages the same native node for animated transforms. When the theme changes, both systems try to update the node simultaneously and the view crashes.

### The fix

Use plain React Native `StyleSheet.create` for static positioning on `Animated.View`. Pass theme-dependent values as inline styles from `useUnistyles()`:

```tsx
// BAD: Unistyles dynamic style on Animated.View
const styles = StyleSheet.create((theme) => ({
  sidebar: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    backgroundColor: theme.colors.surfaceSidebar, // theme-reactive
    overflow: "hidden",
  },
}));

<Animated.View style={[styles.sidebar, animatedStyle]} />;
```

```tsx
// GOOD: static stylesheet + inline theme values
import { StyleSheet as RNStyleSheet } from "react-native";

const staticStyles = RNStyleSheet.create({
  sidebar: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    overflow: "hidden",
  },
});

const { theme } = useUnistyles();

<Animated.View
  style={[staticStyles.sidebar, animatedStyle, { backgroundColor: theme.colors.surfaceSidebar }]}
/>;
```

Regular `View` components can safely use Unistyles dynamic styles — the conflict is specific to `Animated.View`.

## Native Chat Stream Layout

The native agent stream uses an inverted `FlatList`, so chat layout has three coordinate systems:

- chronological stream order
- strategy-ordered array order
- native inverted cell visual order

Do not compute stream neighbors, history/live-head seams, turn footer ownership, assistant block spacing, or tool sequence endings inside React render loops. Those policies live in `packages/app/src/agent-stream/layout.ts` and are unit-tested without React Native rendering.

Platform-specific stream edges belong on `StreamStrategy`:

- forward web uses the last history item as the history/live-head boundary and renders content before a footer
- native inverted uses the first history item as the history/live-head boundary and compensates for inverted cell child order

If a chat footer looks duplicated or appears above the assistant message on mobile, start with `packages/app/src/agent-stream/layout.test.ts`. Do not add a React Native renderer test for this class of bug; make the pure layout invariant fail first.

## Local iOS device builds

Native changes (anything under `packages/expo-two-way-audio/ios/`, or any new Expo module) **cannot be
tested over Metro or EAS Update**. Those ship JS only. A stale dev-client binary silently lacks the new
native functions, so the feature no-ops and the test proves nothing. Rebuild the binary.

Symptom of a stale dev client: `Cannot find native module 'ExpoDocumentPicker'` at startup, followed by a
cascade of `Route "./X.tsx" is missing the required default export` warnings. The route warnings are not a
router bug — the module-level throw aborts `_layout.tsx` evaluation, so its default export never gets
assigned. One missing native module, N confusing warnings.

**Prerequisite: Xcode needs a signed-in Apple ID for the signing team _with a valid keychain token_.** An
account that merely appears in Xcode → Settings → Accounts is not enough — if its `Xcode-Token` is missing,
the build below fails at code signing and blames a _certificate_ instead. See
[Signing needs a working Apple ID token in Xcode](#signing-needs-a-working-apple-id-token-in-xcode) before
you start, not after it fails.

```bash
cd packages/app
npm --prefix ../.. run build:client
APP_VARIANT=development npx expo prebuild --platform ios
APP_VARIANT=development npx expo run:ios --device
```

`APP_VARIANT=development` is required. The `ios` npm script does not set it, and `app.config.js` defaults
to `production` — so a bare `npm run ios` builds `sh.paseo` and collides with the App Store install instead
of the `sh.paseo.debug` dev client. Ignore prebuild's `--non-interactive is not supported` warning; use
`CI=1` if you need non-interactive.

### Signing needs a working Apple ID token in Xcode

Device builds fail with a trio of errors that all point away from the real cause:

```
error: No Accounts: Add a new account in Accounts settings.
error: Provisioning profile "iOS Team Provisioning Profile: *" doesn't include
       signing certificate "Apple Development: <name>".
error: Provisioning profile "iOS Team Provisioning Profile: *" doesn't include
       the aps-environment entitlement.
```

**`No Accounts` does not reliably mean no account is configured.** Check the line _above_ it in the build
log before believing it:

```
DVTDeveloperAccountManager: Failed to load credentials for <apple-id>:
  Invalid credentials in keychain for <apple-id>, missing Xcode-Token
```

That is the actual failure: the Apple ID is registered in Xcode, but its `Xcode-Token` keychain item is gone
(typically after an Apple ID password change or a keychain reset). Xcode reports it as `No Accounts`, then
falls back to whatever stale profile is cached — and if the machine holds a dev cert newer than that
profile, you get the _certificate_ mismatch as a second-order symptom. Chasing the certificate error is a
dead end.

Verify what is actually configured rather than trusting the message:

```bash
# Accounts Xcode knows about
defaults read com.apple.dt.Xcode DVTDeveloperAccountManagerAppleIDLists

# The credential that is actually missing (error => no token)
security find-generic-password -s "Xcode-Token"
```

Fix: Xcode → Settings → Accounts, re-sign-in to the listed Apple ID (removing and re-adding forces a fresh
token). That restores `-allowProvisioningUpdates`, profile regeneration, and push.

Signing an Xcode-_managed_ profile via `CODE_SIGN_STYLE=Manual` is not a workaround; Xcode rejects it with
`is Xcode managed, but signing settings require a manually managed profile`.

If you need a build on the device before the token is fixed, build unsigned and sign by hand with a cert the
cached profile already embeds (list them with `security cms -D -i <profile>.mobileprovision`, then compare
against `security find-identity -v -p codesigning`):

```bash
xcodebuild ... CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build
cp <profile>.mobileprovision "$APP/embedded.mobileprovision"
# sign nested frameworks/dylibs first, then the bundle, then:
xcrun devicectl device install app --device <udid> "$APP"
```

This is a stopgap, not a fix: `expo prebuild` regenerates `packages/app/ios/` and discards it. It also
requires stripping entitlements the cached profile lacks (e.g. `aps-environment`), so push is dead in such a
build.

To verify only that native Swift compiles, skip signing entirely — the pods have their own schemes:

```bash
cd packages/app/ios
xcodebuild -workspace PaseoDebug.xcworkspace -scheme ExpoTwoWayAudio \
  -sdk iphoneos -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
```

Confirm the log compiled _your_ file and not a cached copy: the `SwiftCompile` line should reference
`packages/expo-two-way-audio/ios/...`, not a path inside DerivedData.

### Headless launch cannot verify runtime behavior

`xcrun devicectl device process launch` reports `The app terminated with the exit code 0` about a second
after launch when the phone's screen is off — the app is suspended and killed before the JS bundle loads.
This is **not** a build defect. Confirm with a control: launch `com.apple.Preferences` the same way and
watch it exit identically. Headless install and launch prove the binary is valid and that startup reaches
RN init; anything about on-screen behavior needs a human holding the phone.

## iOS Simulator

```bash
# Screenshot
xcrun simctl io booted screenshot /tmp/screenshot.png

# Dark/light mode
xcrun simctl ui booted appearance          # check current
xcrun simctl ui booted appearance dark     # set dark
xcrun simctl ui booted appearance light    # set light
```

Expo dev server logs are in the tmux pane running `npm run dev`. Daemon logs are at `$PASEO_HOME/daemon.log` (see [development.md](development.md)).
