# Browser Capture Harness

The desktop capture harness is the real-Electron verification path for browser screenshots.
It validates the compositor behavior that unit tests cannot see:

- the resident automation `<webview>` starts in the production parking state;
- the parked guest has no copyable viewport frame;
- the resident webview guest is sized to 1280x800 logical pixels;
- multiple resident webviews are parked as an overlapping stack, and the capture
  target is raised above its sibling webviews before capture;
- the app-style prep sequence moves the host to a paintable 1x1 clipped state, waits two animation frames and a layout read, then both viewport `capturePage` and full-page CDP screenshots return real pixels;
- restore returns the host to offscreen parking after every capture.

Run it with the repo Electron:

```bash
npm run capture-harness --workspace=@getpaseo/desktop
```

The harness writes PNG evidence and `results.json` to:

```text
packages/desktop/capture-harness/out/
```

A passing run prints `PASS` lines for both guest sizes, the expected parked-capture
failure, the legacy stacked-below-the-clip failure for the second webview, five viewport
prep captures and five full-page prep captures for each of the first two webviews, and
final completion. The PNG sizes may be device-pixel scaled; on a Retina display the
1280x800 logical viewport is usually saved as 2560x1600.

## Mechanism

Electron captures copy from the guest web contents' compositor surface. A resident
webview parked at `left:-20000px` and `opacity:0` does not have a copyable surface, and
`capturePage({ stayHidden:false })` or CDP `Page.captureScreenshot` cannot rescue it.

Before pixel capture, the app renderer temporarily makes the resident host paintable:
`left:0`, `top:0`, `opacity:1`, `pointer-events:none`, host size `1x1`, and
`overflow:hidden`, with the full-size 1280x800 webview inside. Resident webviews are
parked absolutely at `0,0` inside that host because a second webview stacked below the
1px clip still has no copyable surface. During capture, the renderer raises the target
webview above the other resident webviews; an overlay or sibling above the target can make
full-page CDP capture fail. Main captures only after the renderer acknowledges two
animation frames plus a `getBoundingClientRect()` read, and the renderer restores parking
in a `finally`.
