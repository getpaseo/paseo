# Composer pill press-and-hold tooltip

Evidence for the `Tooltip` press-and-hold mode and the composer-placement plugin pill opt-in.

## Tested

`npm run test:browser -- src/components/ui/tooltip.browser.test.tsx --bail=1` in `packages/app`

```
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

The five tests use a real Chromium, React DOM, and React Native Web, with the compact layout mocked:

- holding the pill opens the tooltip, and releasing after the hold does not run the pill action;
- a short tap runs the pill action once and opens no tooltip;
- a tooltip that does not opt in keeps the short-tap action and opens nothing on a hold;
- holding a menu pill (`MenuTrigger`, the shape a popover pill like the Kontor pill renders
  through) opens the tooltip and does not open the menu;
- a short tap on that menu pill opens the menu and no tooltip.

### Failing before the change

With `tooltip.tsx` and `buttons/view.tsx` taken from `origin/main` and only the test present:

```
 Test Files  1 failed (1)
      Tests  1 failed (5)
 FAIL  ... > shows the tooltip after a hold without running the pill action
 AssertionError: the given combination of arguments (undefined and string) is invalid
```

The failing assertion is the tooltip text after the hold, so the test fails for the missing behaviour, not for setup.

## Native Android

Emulator `spike37` (arm64-v8a, Android 37, `google_apis_playstore`), debug app `sh.paseo.debug`.

Setup:

- Isolated daemon: `PASEO_HOME=<worktree>/.dev/paseo-home`, `PASEO_LISTEN=127.0.0.1:6768`,
  `KONTOR_PLUGIN_MCP=off`. The live daemon on `6767` and `~/.paseo` were not touched.
- App: `JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`,
  `ANDROID_HOME=$HOME/Library/Android/sdk`,
  `EXPO_PUBLIC_LOCAL_DAEMON=10.0.2.2:6768`,
  `REACT_NATIVE_PACKAGER_HOSTNAME=10.0.2.2`, then `npm run dev:android`.
- Session: `paseo run "Reply OK and stop." --provider codex --title "LSA • Native QA"`.
- Plugin: the `_tools/asma-rs-kontor` copy was installed first and showed the tooltip text
  `Open Kontor` (its `RETURN_CONTROL_TITLE`). To observe the session-name text the operator
  described, the newer `asma-rs-kontor` worktree copy with `composerSessionPresentation` was
  installed into the same home. Both copies opened the tooltip on hold and kept it after release;
  the newer one supplied `LSA • Native QA · Idle`.

Observed with the session-name copy, using `adb shell input swipe x y x y 900` for the hold:

1. Holding the pill for about 900 ms shows `LSA • Native QA · Idle` above the pill
   (`android-hold-tooltip.png`).
2. The tooltip is still present after the finger lifts, and still present 5 s later.
   `uiautomator` reports the full-screen `tooltip-dismiss` overlay and the text at
   `[44,1883][378,1930]`.
3. Tapping away dismisses it.
4. A short tap with no tooltip opens the pill's surface once (`android-short-tap.png`).
5. Tapping the pill while the tooltip is open dismisses only; the surface does not open until the
   next tap.

There was no dismiss-on-lift, no tap action after the hold, and no menu opening from the hold.

## Screenshot

`press-and-hold.png` is the open tooltip after the hold. It comes from the bare component
harness, so the app theme and the real composer row are not applied. It shows the tooltip text
and placement, not the production styling.

The `android-*.png` files are the real debug app on the emulator: the session with its pill
before any gesture, the tooltip after the hold and release, and the surface opened by a short
tap.

## Static checks

- `npm run typecheck` (workspace root): exit 0, after `npm run build:server` so the CLI's
  cross-package declarations exist.
- `npm run lint`: 0 warnings, 0 errors.
- `npm run format`: exit 0, no changes.

## Platform coverage

| Platform        | Tested | Notes                                                                                      |
| --------------- | ------ | ------------------------------------------------------------------------------------------ |
| iOS             | No     | Native long press not run on a device or simulator.                                        |
| Android         | Yes    | Emulator `spike37`, API 37, arm64-v8a, debug app; hold, release, dismiss and tap observed. |
| Web             | Yes    | Chromium, compact layout mocked; tooltip rendered through the portal.                      |
| Desktop macOS   | No     | Electron wrapper not run.                                                                  |
| Desktop Windows | No     |                                                                                            |
| Desktop Linux   | No     |                                                                                            |

The automated test uses a mouse hold on the web responder system. Native Pressability's own
long-press timer and `onPress` cancellation were exercised on the Android emulator; iOS remains
unexercised.
