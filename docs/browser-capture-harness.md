# Browser Capture Harness

The desktop capture harness is the real-Electron verification path for browser screenshots.
It validates the compositor behavior that unit tests cannot see:

- the resident automation `<webview>` starts in the production parking state;
- the parked guest remains paintable and has a copyable viewport frame;
- the resident webview guest is sized to 1280x800 logical pixels;
- multiple resident webviews are parked as an overlapping stack without per-capture
  stacking changes;
- a newly attached resident webview whose first useful frame is delayed can be captured
  by retrying until the frame appears;
- both viewport `capturePage` and full-page CDP screenshots return real pixels from
  the permanent production parking state;
- guest background throttling can be disabled once at attach without per-capture
  renderer coordination;
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

A passing run prints `PASS` lines for the production P1 attach-off parking state,
including fresh, settled, 75-second soak, multi-tab, viewport, and full-page checks. The
PNG sizes may be device-pixel scaled; on a Retina display the 1280x800 logical viewport
is usually saved as 2560x1600.

## Mechanism

Electron captures copy from the guest web contents' compositor surface. A resident
webview parked with `display:none`, offscreen coordinates, or `opacity:0` can lose its
copyable surface. The production parking state keeps the host fixed at `left:0`, `top:0`,
`width:1px`, `height:1px`, `overflow:hidden`, `opacity:1`, and `pointer-events:none`.
The webviews inside stay full-size at 1280x800, `display:inline-flex`, and absolutely
overlap at `left:0`, `top:0`.

There is no renderer prep/restore handshake. Main disables guest background throttling
once when the webview attaches, then screenshot capture uses the shared serialized queue,
invalidates before each attempt, and retries known first-frame failures within the
5-second capture budget. Viewport screenshots use `capturePage({ stayHidden:false })`;
full-page screenshots use the existing CDP path with layout metrics and screenshot clip.
