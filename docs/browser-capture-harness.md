# Browser Capture Harness

The desktop capture harness is the real-Electron verification path for browser screenshots.
It validates the compositor behavior that unit tests cannot see:

- the resident automation `<webview>` starts in the production parking state;
- the parked guest remains paintable and has a copyable viewport frame;
- a never-presented resident webview guest defaults to 1280x800 logical pixels;
- multiple resident webviews are parked as an overlapping stack without per-capture
  stacking changes;
- a newly attached resident webview whose first useful frame is delayed can be captured
  by retrying until the frame appears;
- both viewport `capturePage` and full-page CDP screenshots return real pixels from
  the permanent production parking state;
- parked guests remain capturable with Chromium background throttling enabled;
- production trusted clicks reach parked guests with an unfocused, hidden, or minimized
  host without changing window focus, guest identity, or URL, and hidden animation stops
  again after input (minimization is reported unsupported when the window manager does
  not implement it); minimized Windows gestures can take several seconds at its
  reduced frame cadence, so input checks use the agent broker's 15-second deadline;
- the real-Electron host-composer sentinel proves guest Enter cannot submit a focused
  host composer;
- the automation group loads the compiled production keyboard boundary and guest
  preload, then proves that initial page window handlers get first refusal, unhandled
  shortcuts synchronously suppress editable browser defaults before crossing the host
  boundary, shortcuts marked unavailable in editable targets retain the browser field's
  native behavior, handlers registered after preload still get first refusal, focused
  iframes share the same boundary, digit wildcard shortcuts cross, and background automation
  stays in the guest.

Run it with the repo Electron:

```bash
npm run capture-harness --workspace=@getpaseo/desktop
```

Build the desktop main process before the automation group so its production guest
preload is available:

```bash
npm run build:main --workspace=@getpaseo/desktop
PASEO_CAPTURE_HARNESS_GROUP=automation npm run capture-harness --workspace=@getpaseo/desktop
```

Run the shared browser profile fixture with:

```bash
PASEO_CAPTURE_HARNESS_GROUP=browser-profile npm run capture-harness --workspace=@getpaseo/desktop
```

On macOS, test native titlebar dragging after scrolling with:

```bash
PASEO_CAPTURE_HARNESS_GROUP=titlebar-drag npm run capture-harness --workspace=@getpaseo/desktop
```

This group needs Xcode Command Line Tools and Accessibility permission for the
terminal running it. It sends real mouse input to its test window and checks
window movement, including button clicks and a portal over the titlebar. Leave
the mouse idle during this group. It reads the app's production CSS and writes
screenshots and window bounds to the output directory.

The browser profile group runs two Electron processes in sequence. It verifies that each
renderer-side `did-attach` identity maps to the correct main-process guest, that two live
tabs share cookies and local storage through one persistent session, and that the data is
still present after the first Electron process exits and the second starts.

The automation group uses a real guest webview to verify the page-side ref contract:
ARIA-like snapshot text includes headings, static text, and controls; refs survive
`pushState` when the element still matches; same-URL rerenders stale old refs; and a
file-input ref can be resolved to a CDP backend node id for upload. It also verifies
page-context evaluation, including passing a resolved ref element as the function argument.
Keyboard containment runs last because the host-composer sentinel intentionally leaves
native focus in the host. It reuses an existing fixture button: adding a test-only control
changes the inline fixture geometry exercised by the earlier actionability checks.

On macOS the harness process must set `app.setActivationPolicy("accessory")` and
hide the Dock icon before creating any window. `showInactive()` only prevents window
focus; a normal Electron app launch can still activate the app and steal focus.
Harness windows are then created hidden, positioned in a screen corner, skipped from
the taskbar where Electron supports it, and revealed with `showInactive()` from
`ready-to-show`. Do not replace this with `show()`, `focus()`, or `app.focus()`:
the compositor only needs visible inactive windows, and harness runs must not steal
focus from the person using the machine.

The harness writes PNG evidence and `results.json` to:

```text
packages/desktop/capture-harness/out/
```

A passing run prints `PASS` lines for the production P1 default-throttling parking state,
including fresh, settled, 75-second soak, multi-tab, viewport, and full-page checks. The
PNG sizes may be device-pixel scaled; on a Retina display the 1280x800 logical viewport
is usually saved as 2560x1600.

The existing `npm run test:e2e:browser-tabs --workspace=@getpaseo/desktop` journey
verifies that a hidden window stops guest animation, captures fresh viewport pixels,
and resumes animation after restoring the window. Its artifacts include the screenshot
and animation measurements. Detach Playwright during native visibility checks: its host
session owns a visible-capture lease through focus emulation. A second CDP session cannot
release that lease. Observe the main process and guest through the existing agent bridge
while hidden, then reconnect Playwright for the remaining UI journey. Full-page content correctness remains separately tracked in
[the full-page repetition bug](https://github.com/getpaseo/paseo/issues/3196).

## Mechanism

Electron captures copy from the guest web contents' compositor surface. A resident
webview parked with `display:none`, offscreen coordinates, or `opacity:0` can lose its
copyable surface. Each production webview keeps one permanent body-level surface. Presenting
or parking changes that surface's geometry without reparenting the webview. The parking state
uses `left:0`, `top:0`, `width:1px`, `height:1px`, `overflow:hidden`, `opacity:1`, and
`pointer-events:none`. The webview stays at its resolved logical viewport, defaulting to
1280x800 before first presentation, with `display:inline-flex` at `left:0`, `top:0`.
Presentation resolves responsive guests to the pane's exact pixel dimensions after the surface
has visible bounds. Do not apply percentage guest sizing against the parked surface: Electron
exposes the 1x1 parking geometry as a real guest resize before expanding it again.

The permanent browser host and `overlay-root` are explicit sibling paint planes. The browser
plane stays below the overlay plane regardless of body insertion order; menus keep their relative
layering inside `overlay-root`. Activating a presented browser also focuses its registered guest
`WebContents` in main so macOS assigns keyboard first-responder ownership to the page.

There is no renderer prep/restore handshake or lifetime background-throttling override.
Screenshot capture and trusted input temporarily enable frame production. CDP pointer
commands need compositor acknowledgments even for mouse movement in a hidden guest.
Overlapping operations share the guest scope and restore its prior throttling policy after
the last operation, including failure and cancellation. Await a post-input paint before
releasing activity because wheel acknowledgments can precede animation-aligned delivery.
Captures retain their five-second budget. Sample actionability with main-process
timers because guest timers and animation frames can be suspended.

Input has a 15-second main-process deadline, including time waiting behind another
gesture. A stalled renderer or debugger must release the activity scope. Already
dispatched input cannot be recalled, so a missing acknowledgment after dispatch
is not retryable. Actionability failures before dispatch remain safe to retry.
Fence later gesture steps and release a possibly held pointer at the last
acknowledged position; never repeat the press or synthesize a drop at the
unreached destination. Dialog interception ends with its command: prompt
restoration cannot wait behind a missing pointer acknowledgment. Navigation or closure after delivery can interrupt the paint wait
without turning successful input into a failed action.

Use Electron 44.5 or newer ([upstream restoration fix](https://github.com/electron/electron/pull/54341)). Earlier runtimes can leave hidden webview widgets and their
Blink schedulers active after background throttling is restored. The runtime fix is required
for command-scoped activity to return to idle without presenting the pane or focusing the host.
The browser tool takes one viewport frame through Electron's frame subscription and releases the
subscription on completion or cancellation. A resized resident guest can produce fresh pixels
while `capturePage()` leaves its surface-copy request pending; waiting for animation frames or
retrying the copy does not repair that state. Full-page screenshots retain the CDP path with layout
metrics and screenshot clip.
