# Window chrome

On Windows and Linux the desktop window has no native frame and no Chromium Window Controls Overlay. `getMainWindowChromeOptions()` in `packages/desktop/src/window/window-manager.ts` sets `titleBarStyle: "hidden"`, `frame: false`, and `autoHideMenuBar: true`; the app draws minimise, maximise, and close itself. macOS keeps `titleBarOverlay: true` and a `trafficLightPosition`, so the OS draws real traffic lights in the top-left.

Nothing floats over the renderer there, so no header reserves a band.

## The buttons are items in the header row

`WindowControls` renders into the header's own flex row, so it takes the header's metrics: 28x28 buttons, 4px gaps, ending 12px from the window edge like every other header icon. Windows draws its own caption buttons at 46x32 logical. Ours are smaller on purpose, and that costs touch-target size.

## Placement is corner ownership, not padding

`useOwnsWindowChromeCorner("top-right")` decides which surface mounts `WindowControls`, and `WindowChromeRegion` hands that corner to one surface so two nested surfaces cannot both mount a set. Assign the corner from geometry, not from which panel is open. `WorkspaceChromeRow` used to pass `top-right` to the explorer column whenever the explorer was open, but the workspace header spans the full window width above that column, so the corner went to a column that does not touch the top edge. If a surface starts below another surface's header, it does not own the window's corner.

macOS is the only platform that still reserves space. `DESKTOP_TRAFFIC_LIGHT_WIDTH` and `DESKTOP_TRAFFIC_LIGHT_HEIGHT` in `packages/app/src/constants/layout.ts` keep the top-left clear of the traffic lights, and `resolveWindowChromeObstruction` returns nothing on every other platform.

## Trailing actions grow leftward

A rigid trailing cluster that outgrows its row overflows where the row's `justifyContent` decides. With negative free space `space-between` behaves like `flex-start` and pushes the cluster off the window edge, controls included. `flex-end` overflows at the start and pushes it leftward into the title, which truncates. Any header row that mounts the controls uses `flex-end` with a `flex: 1, minWidth: 0` leading group and a `flexShrink: 0` trailing group.

Measured with four extra 90px actions appended to the workspace header cluster: under `space-between`, two actions crossed into the controls at 1000px and four at 800px, one of them past the window edge. Under `flex-end` the cluster's right edge pins to the content box at every width.

Leftward overflow still breaks eventually. Once the leading group is gone the cluster runs off the left edge, and nothing folds actions into the header's `...` menu yet. That overflow is tracked separately.

## What drawing our own gives up

- **Windows 11 snap layouts.** The flyout needs `WM_NCHITTEST` to return `HTMAXBUTTON` over the maximise button. Chromium maps `-webkit-app-region: drag` to `HTCAPTION` and everything else to `HTCLIENT`, so no HTML element can claim it, and Electron closed the request as NOT_PLANNED (electron/electron#31372). VS Code documents the same limit and points `window.controlsStyle: "custom"` users at `Win+Z` (microsoft/vscode#127449). Tested by hand on Windows 11: hovering our maximise button shows no flyout, `Win+Z` works.
- **Per-OS glyphs and theme-following hover states.** Ours follow the app's palette instead of the desktop's.
- Linux desktops can put caption buttons on either side, which no longer reaches us because we draw ours on the right.

## Double-click comes free

Double-clicking a `-webkit-app-region: drag` region maximises and restores with no JS handler. VS Code has no listener for it either. Tested by hand on Windows 11.

## Fullscreen is not a Windows window state

Windows and Linux have minimise, maximise and close; there is no macOS-style fullscreen with its
own affordance. F11 still reaches it through the View menu's `togglefullscreen` role, and the OS
then reports `isMaximized() === false` even though the window fills the screen, so a control keyed
off maximised alone offers "Maximize" on an already-full window. `resolveMiddleControlMode` in
`packages/app/src/utils/window-controls-mode.ts` answers with Windows' own vocabulary: both large
states read "Restore" and draw the same glyph, and only the action differs, because leaving
fullscreen is not the same call as unmaximising.

The header and the controls stay visible in fullscreen. macOS hides its traffic lights there
because the OS owns them; ours are header content, and hiding them would leave no visible way back
from a state the user can reach with one keystroke.

## Nothing draws the buttons before the bundle mounts

The app's controls do not exist until the renderer paints and the bundle mounts, and never if the bundle throws or the page fails to load. A frameless window in that state closes only through Alt+F4 or the taskbar. Two mechanisms cover it.

`packages/desktop/src/preload.ts` injects a plain-DOM fallback set — `#paseo-boot-window-controls`, buttons under `data-testid="boot-window-control-*"` — onto `documentElement` while the document is still parsing, and a MutationObserver hides it once `[data-testid="window-control-close"]` exists. Exactly one set is visible at any moment. Measured from cold against a Metro dev server: fallback visible at t+21s, app row mounted and fallback hidden at t+28s.

Do not move that injection to `DOMContentLoaded`. The event does not fire until the app bundle has executed, which is the window the fallback exists to cover. Ferdium shipped the permanent version of this bug when its titlebar dependency failed to load (ferdium/ferdium-app#230). A splash screen does not solve it either: VS Code's pre-workbench splash (`src/vs/code/electron-browser/workbench/workbench.ts`) paints the titlebar background with no buttons in it. Standard Notes' static-HTML buttons (`packages/desktop/app/index.html`) are the prior art that works.

`setupWindowFailureRecovery()` covers the other end. A dead or hung renderer takes every DOM-drawn control with it, so the main process prompts with Reload and Close on `unresponsive`, `render-process-gone`, and `did-fail-load`. Tested by hand: crashing the renderer showed the native dialog, and Reload recovered the window.

## Pair the hover background with the glyph colour

Recolour the glyph and paint its hover surface from the same palette. Recolouring only the glyph leaves its contrast dependent on whatever paints the header, which is how a hovered glyph rendered `#1a1a1e` on a dark header and disappeared.

## Verifying

Run the desktop verifier and read the `app-window-controls-clearance` check. It asserts that exactly one control set is visible, that no other interactive element intersects the buttons, and that every button has an accessible name.

```bash
npm run verify:electron-cdp --workspace=@getpaseo/desktop
```

The check reports `skipped` on macOS, so a green run there says nothing about Windows or Linux.
