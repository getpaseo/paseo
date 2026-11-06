# Mobile workspace tab list QA

All commands and application runs were performed on `rrd-mac-studio` on 2026-10-24.
The fixture titles describe a fictional community science exhibition. No titles or images from
the user's screenshot were reused.

Implementation commit: `08d42f212`, based on upstream `72e3316f4`.

## Automated checks

```sh
npm run format
npm run typecheck
npm run lint
npx vitest run packages/app/src/screens/workspace/workspace-tab-agent-details.test.ts packages/app/src/hooks/use-settings/storage.test.ts packages/app/src/i18n/resources.test.ts --bail=1
cd packages/app
E2E_RECORD_VIDEO=1 npm run test:e2e -- e2e/browser/workspace-tab-switcher-rename.spec.ts
```

The three unit suites passed 158 tests. The browser suite passed six tests:

- Rename an agent through its tab actions sheet.
- Create terminal and draft tabs, then return to the existing chat.
- Render two-line, three-line and unlimited titles; show provider/model/thinking details;
  drag unequal-height rows; reload and verify the saved order; select the reordered tab.
- In the three-line case, send a mock turn, observe the elapsed duration change, cancel it,
  and verify the duration disappears.
- Change each title limit in Appearance and verify persistence after reload.

Raw output is in `checks.txt`. Metro also emitted diagnostic stacks naming the SVG components
in `sidebar-close-button.tsx` and `context-window-meter.tsx`; those messages are retained in the
log and were not investigated in this change. The assertions listed above passed.

## Native gestures

The dedicated API 37 Android emulator used a development shell with the current SDK 57 native
runtime and loaded this checkout through Metro on port 19331. The private fixture daemon used
its own home and port. Neither the installed daemon nor another task's emulator was restarted.
The native shell APK hash is recorded in `apk-sha256.txt`; this was a JavaScript change loaded
into that development shell, not a new release APK.

`native-gestures.py` captures the actual native accessibility tree and screenshots. It opens the
tab list, holds the first row for one second, moves it below its neighbour, releases it, checks
the new order, closes the list and checks the order after reopening. The earlier Android
`input draganddrop` attempt did not hold long enough to arm the row; the recorded passing run
uses explicit DOWN/MOVE/UP events.

| Surface                                      | Result                                                                 | Evidence                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Browser, 390 × 844                           | Six E2E tests passed                                                   | `checks.txt`, `web-two-lines.png`, `web-three-lines.png`, `web-unlimited.png` |
| Android phone width, 1080 × 2424 at 420 dpi  | Long press, reorder and reopen passed                                  | `android-phone.png`, `android-phone.txt`                                      |
| Android tablet width, 1080 × 2424 at 240 dpi | Wide header entry, bottom sheet, long press, reorder and reopen passed | `android-tablet.png`, `android-tablet.txt`, `android-tablet-drag.mp4`         |
| iOS / iPadOS                                 | Not exercised                                                          | Native runtime and gesture acceptance remain unverified                       |
| Electron / Windows / Linux                   | Not exercised                                                          | No desktop tab strip changes                                                  |

The native recording shows the tablet-width interaction. Phone/tablet widths were exercised on
one dedicated emulator, not on physical devices. Ordering uses the existing client workspace
layout persistence; this PR does not add cross-client order synchronization. Duration is the
current active turn's elapsed time, not agent age or cumulative lifetime runtime.
