# Window chrome

On Windows and Linux the desktop window has no native frame. `getMainWindowChromeOptions()` in `packages/desktop/src/window/window-manager.ts` sets `titleBarStyle: "hidden"`, `frame: false`, and a Chromium Window Controls Overlay. The minimize/maximize/close buttons float over the renderer, so every header that reaches the top edge has to leave room for them.

## Why this file exists at all

Most cross-platform Electron apps never face this, because they made a different choice one level
up. Element and Signal Desktop keep the standard OS frame on Windows and Linux and hide it only on
macOS, so nothing overlaps their UI. Standard Notes and VS Code go frameless and draw their own
buttons in HTML, which lets them hardcode the size they authored — 35px, 32px, `138px` wide, some
divided by a zoom factor. Only apps that let the OS draw the buttons have geometry they do not own,
and those apps all derive it: VS Code from CSS `env(titlebar-area-*)` on Linux and web, Automattic's
Studio and Trilium from `getTitlebarAreaRect()` in JavaScript. None of them cache it.

Paseo is in the second group by choosing Electron's native overlay, which is what buys the OS
behaviours a hand-drawn button loses — Windows 11 snap layouts on maximize hover, correct glyphs per
OS, and theme-following hover states. The price is that the size is not ours to state, so we measure.
Swapping to hand-drawn controls would make a constant legitimate again; that is the trade, and it is
a bigger change than this file.

## Measure, don't guess

`navigator.windowControlsOverlay` is the source of truth. The method is `getTitlebarAreaRect()` — lowercase `b`, not the `getTitleBarAreaRect` the spec drafts use. A guard that probes the wrong spelling finds nothing, silently falls back to the constants, and the bug looks like the measurement code never ran. It returns the part of the title bar the controls do **not** cover, so the reserved insets are what is left over on each side:

- left inset = `rect.x`
- right inset = `window.innerWidth - (rect.x + rect.width)`

`DESKTOP_WINDOW_CONTROLS_WIDTH` and `DESKTOP_WINDOW_CONTROLS_HEIGHT` in `packages/app/src/constants/layout.ts` are the fallback for a platform that reports no usable rect. Measured on Windows 11 at 1440px CSS: the controls are 137px wide and 28px tall, against constants of 140 and — before this was measured — 48. The width is close enough that a constant only wastes a few pixels; the height is what breaks layout, and it is not a number the app gets to choose. Electron asks for 29 and installs 28 (see the constant's comment), and Linux hands the whole decision to the desktop environment, so measuring is the only way to stay correct without a constant that has to be re-synced by hand every time either side changes.

## Both corners are reservable

Windows keeps the controls on the right, and there they really are a fixed width — measured 136,
137 maximised. Linux is the reason not to hardcode that, and it is not theoretical: Electron 41.2.0
under WSL2/WSLg reports `{ x: 0, width: 1104, height: 29 }` in a 1200px window, so the controls take
**96px** and stand **29px** tall. A 140px constant over-reserves 44px of header there, and the height
differs from the 28px Windows installs. Identical figures came back from the X11 and the Wayland
backend, at device pixel ratios of 1 and 2, so the inset is scale-independent.

What that run does **not** show is the layout following the desktop. With `xsettingsd` publishing
`Gtk/DecorationLayout "close,minimize,maximize:appmenu"` — confirmed on the X server by
`dump_xsettings`, and confirmed read by GTK itself via `gtk-query-settings`
(`gtk-decoration-layout: "close,minimize,maximize:menu"`) — and with
`org.gnome.desktop.wm.preferences button-layout` set to the same left-hand value, Electron 41.2.0
still reported `x: 0` and a 96px band on the right. Same answer under `--gtk-version=3`,
`--gtk-version=4`, and the Wayland backend. So GTK settings alone do not move the controls; WSLg
runs its own compositor rather than a GNOME session, and a real mutter session is still untested.

Treat the side as variable anyway. Electron's breaking-change note is explicit that frameless WCO
windows "adopt the native title bar layout and user settings on Linux", that buttons can sit left,
right, **or both**, and that GNOME shows only the close button by default. Reserving from whichever
side the measured rect reports costs nothing extra and needs no per-platform branch, which is why
`WindowChromeProvider` feeds both corners.

## The surface that touches the top edge owns the corner

`WindowChromeRegion` hands a corner to one surface so two nested surfaces can't both pad for the same controls. Assign it from geometry, not from which panel is open. `WorkspaceChromeRow` used to pass `top-right` to the explorer column whenever the explorer was open, but the workspace header spans the full window width above that column: the header stayed unpadded, the explorer discarded the corner because none of its panes touch the top edge, and the header icons ended up under the controls. If a surface starts below another surface's header, it does not own the window's corner.

## Trailing actions grow leftward, never into the reservation

Reserved padding only holds while the row has slack. A rigid trailing cluster that outgrows the
space left for it overflows the padding box, and where it overflows is decided by the row's
`justifyContent`: with negative free space `space-between` behaves like `flex-start` and pushes
the cluster through the reservation and off the window edge, while `flex-end` overflows at the
start and pushes it leftward into the title, which truncates. Any header row that owns a corner
uses `flex-end` with a `flex: 1, minWidth: 0` leading group and a `flexShrink: 0` trailing group;
the two look identical until the cluster grows, which is the point.

Measured with four extra 90px actions appended to the workspace header cluster: under
`space-between`, two actions crossed into the controls at 1000px and four at 800px, one of them
past the window edge entirely. Under `flex-end` the cluster's right edge pins to the content box
at every width and the overflow moves left.

Growing leftward is not the same as staying usable. Once the leading group is gone the cluster
still runs off the left edge, and nothing folds actions into the header's `...` menu yet. That
overflow behaviour is tracked separately; this rule only guarantees the controls stay clear.

## `geometrychange` alone drops updates

Subscribe to `geometrychange` on the overlay **and** `resize` on the window. Maximize, unmaximize, and zoom-factor changes do not all emit `geometrychange`, and a missed event leaves the header padded for the previous geometry until something else re-renders it.

`visible` does not mean "drawn right now". It means the overlay feature is enabled, and it stays
true in fullscreen where the controls are hidden — VS Code documents the same trap in
`src/vs/base/browser/browser.ts`. So fullscreen is handled by the Electron bridge's fullscreen
state, which is checked before the measurement; `visible: false` only tells you the platform is
not running an overlay at all, and reserves nothing.

## Verifying

Run the desktop verifier and read the `window-controls-overlay-clearance` check. It derives the occupied bands from the live rect and fails with the offending elements' names and rects when an interactive node intersects one.

```bash
npm run verify:electron-cdp --workspace=@getpaseo/desktop
```

The check reports `skipped` wherever there is no visible overlay — macOS builds and fullscreen — so a green run on macOS says nothing about Windows or Linux.
