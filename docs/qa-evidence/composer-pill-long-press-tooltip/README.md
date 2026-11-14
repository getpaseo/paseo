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

## Screenshot

`press-and-hold.png` is the open tooltip after the hold. It comes from the bare component
harness, so the app theme and the real composer row are not applied. It shows the tooltip text
and placement, not the production styling.

## Static checks

- `npm run typecheck` (workspace root): exit 0, after `npm run build:server` so the CLI's
  cross-package declarations exist.
- `npm run lint`: 0 warnings, 0 errors.
- `npm run format`: exit 0, no changes.

## Platform coverage

| Platform        | Tested | Notes                                                                 |
| --------------- | ------ | --------------------------------------------------------------------- |
| iOS             | No     | Native long press not run on a device or simulator.                   |
| Android         | No     | Native long press not run on a device or emulator.                    |
| Web             | Yes    | Chromium, compact layout mocked; tooltip rendered through the portal. |
| Desktop macOS   | No     | Electron wrapper not run.                                             |
| Desktop Windows | No     |                                                                       |
| Desktop Linux   | No     |                                                                       |

The interaction in the automated test is a mouse hold on the web responder system, which is
the same gesture path React Native Web uses. Native Pressability has its own long-press timer
and its own `onPress` cancellation; that path was read in `react-native@0.86.3`
(`Libraries/Pressability/Pressability.js`, `isPressCanceledByLongPress`) but not exercised.
