# Read-Aloud Selection Anchoring Plan

> **Status: all three steps landed.** See [Outcome](#outcome) at the bottom for what shipped,
> what changed from this plan, and the browser measurements behind each case.

The read-aloud button (`packages/app/src/read-aloud/`) anchors to
`range.getBoundingClientRect()` — the box around the **entire** selection. Select more
than a screenful, or scroll after selecting, and the selection's top edge is off-screen;
the button clamps to the top of the window, nowhere near what the user is looking at.

Goal: anchor to the part of the selection that is **actually visible**, in the pane it
actually lives in.

## The three bugs

They are independent. 1 is the reported symptom; 2 and 3 were found while investigating it.

### 1. Anchors to the whole selection, not the visible part

```
    ▓▓▓▓▓▓ selection starts up here ▓▓▓▓▓▓▓▓▓      ⇠ scrolled out of view
  ┌─ viewport ─────────────────────────────────┐
  │ ( 🔊 )  ← clamped to y=8, on top of text   │  ✗ not where you're looking
  │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓   │
  │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ …and ends here.         │  ← eyes here
  └────────────────────────────────────────────┘
```

Wanted: anchor below the visible **end** when the start is clipped; keep today's
above-the-start placement otherwise.

### 2. "Visible" is measured against the window, not the scroll pane

Client rects ignore ancestor `overflow` entirely. The timeline scrolls inside
`div[data-testid="agent-chat-scroll"]` (`packages/app/src/agent-stream/strategy-web.tsx`,
~line 618), which occupies only part of the window. Text scrolled out of _that pane_ still
reports a rect inside the window:

```
  ┌─ window ───────────────────────────────────┐
  │ ┌ sidebar ┐ ┌─ agent-chat-scroll ────────┐ │
  │ │         │ │  ▓▓▓ selection ▓▓▓         │ │
  │ │         │ │  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓           │ │  ← the real visible box
  │ │         │ └────────────────────────────┘ │
  │ │         │   ░░░ scrolled out of the pane │  ← still "in the window"
  │ │         │   ░░░ but invisible            │     per getBoundingClientRect
  │ └─────────┘ ┌─ composer ─────────────────┐ │
  └─────────────┴────────────────────────────┴─┘
```

The same mistake exists on the x-axis today: the clamp uses `window.innerWidth` and
ignores the sidebar. Fixing 2 fixes that for free.

### 3. Scrolling away kills playback

`packages/app/src/agent-stream/strategy-web.tsx` sets `overscan: 8`; rows outside that
window unmount. The range's boundary nodes detach → `isReadAloudEligible`'s `isConnected`
check fails → the anchor goes null → the `useEffect` in the bubble calls
`stopReadAloud()`. **Scrolling a long conversation stops audio mid-sentence.** No amount
of positioning work fixes this.

## Traps (verified during investigation — do not rediscover)

- **`getClientRects()` is not one rect per line.** It also returns rects for element boxes
  fully contained in the range, so a selection spanning a `<p>` contributes that
  container's full-height rect. `rects[0]` and `rects[N-1]` can each be the entire
  selection box — taking first/last reproduces bug 1.
- **Use collapsed clones instead.** `range.cloneRange()` collapsed to start and to end
  gives two caret rects carrying each endpoint's line height. O(1) per frame rather than
  scanning thousands of fragments on every scroll tick, and immune to container
  contamination.
- **Caret rects are zero-width.** The existing `rect.width === 0 && rect.height === 0`
  guard in `readSelectionAnchor` must become height-only, or every anchor is rejected.
- **`clampToViewport` inverts on a small box.** `Math.max(PADDING, Math.min(viewport -
size - PADDING, value))` — when `viewport < size + 2 * PADDING` the `Math.max` wins and
  pushes the bubble past the far edge. Never fires against `window.innerHeight`; fires
  readily against a short diff pane once the basis becomes `visibleBox`.
- **`centerX` must come from the anchored rect**, not the bounding box. Anchor to the
  bottom while centering on the whole selection and the bubble drifts sideways on wide
  code blocks and diffs.
- **Neither `scroll` nor `resize` fires on reflow** — streaming output, virtualizer row
  remeasure, dragging `components/resize-handle.tsx`. A `ResizeObserver` on the scroll
  container is the repo-consistent fix (precedent: `strategy-web.tsx` ~415-440).
- **Coordinate space and the scroll listener are already right.** `#overlay-root` is
  `position: fixed; inset: 0` (`packages/app/src/lib/overlay-root.ts`), so absolute coords
  inside it are viewport coords — no conversion needed. `window.addEventListener("scroll",
…, true)` already catches nested scrollers via capture phase. Don't "fix" either.

## Nothing in the repo already does this

`computeHoverCardPosition` (`components/workspace-hover-card.tsx`) and `computePosition`
(`components/ui/tooltip.tsx`) both take a `displayArea` and clamp into it — the right
_shape_, but they know nothing about target visibility and are `measureInWindow`/RN-flavored.
`components/ui/combobox.tsx` uses `@floating-ui/react-native`; only that package is a
dependency, so `@floating-ui/dom`'s clipping-ancestor detection is **not** available and is
not worth pulling in for a 32px button. `docs/floating-panels.md` is explicit: copy the
closest file and trim rather than inventing a shared primitive.

The reusable idea is the `displayArea` parameter. `visibleBox` slots into that role.

## Algorithm

Per frame: `firstRect` (start-endpoint caret rect), `lastRect` (end-endpoint caret rect),
`visibleBox`.

```
visibleBox = intersect(windowRect, every clipping ancestor's rect)
visible(r) = r.bottom > visibleBox.top && r.top < visibleBox.bottom
```

| Case                               | Anchor rect  | Placement                                     |
| ---------------------------------- | ------------ | --------------------------------------------- |
| Both endpoints visible             | `firstRect`  | above; flip below if it doesn't fit (today's) |
| Top clipped, bottom visible        | `lastRect`   | **below**; flip above if it doesn't fit       |
| Bottom clipped, top visible        | `firstRect`  | above; flip below if it doesn't fit (today's) |
| Both clipped (taller than the box) | `visibleBox` | near its **bottom** edge, inside the box      |
| Entirely outside `visibleBox`      | idle → hide  | speaking → park at nearest `visibleBox` edge  |

Both-clipped anchors to `visibleBox`, not to a scanned mid-selection rect: the property
that matters is stability under scroll, and a mid-selection rect jitters as you scroll
while costing O(N) exactly when N is largest. **Accepted imperfection, document it:** a
selection with a large unselected gap in the middle can put the button over unselected
content.

The entirely-outside case must split on playback state — while speaking, that button is
the only stop control.

## Sequencing

Land 1 and 2 together (2 is a prerequisite for 1 being correct). 3 is separable and can
ship independently, before or after.

### Step 1 — `visibleBox`

`packages/app/src/read-aloud/use-selection-anchor.web.ts`

Walk `parentElement` from the range's start element, collecting elements whose computed
`overflow-x`/`overflow-y` is `auto | scroll | hidden | clip`. **Compute the chain once when
the selection settles and cache it** — the chain doesn't change on scroll, only its rects
do — so per-frame cost is a handful of `getBoundingClientRect()` calls. Invalidate on
`selectionchange` and on node disconnect. Add a `ResizeObserver` on the nearest scroll
container.

### Step 2 — anchor to the visible edge

`use-selection-anchor.web.ts` returns geometry (`text`, `firstRect`, `lastRect`,
`visibleBox`); `read-aloud-selection-bubble.web.tsx` decides above/below and clamps, since
it alone owns the width constants. Note the bubble has **three** widths — `BUBBLE_WIDTH`,
`SPEAKING_BUBBLE_WIDTH` (icon + speed chips), `FAILED_BUBBLE_WIDTH` — so the anchor math
keys off whichever pill is showing. Fix the `clampToViewport` degenerate-box inversion
(centre in the box when it is too small to clamp into).

### Step 3 — decouple playback lifetime from anchor liveness

The text is captured at settle time and playback needs no live range. While
`status !== "idle"`, retain the last-known anchor parked at the nearest `visibleBox` edge
instead of nulling. Stop only on explicit intent: pressing stop, Escape, or a new non-empty
selection. This changes the `useEffect` on `anchor` in the bubble, not the geometry.

Keep `handlePointerDown` nulling the anchor on outside mousedown — that is defensible UX
and not part of this problem.

## Verification

Vitest cannot see any of this — it is layout behavior. Verify in a real browser via
Playwright MCP against the dev stack (see the handoff doc for how to bring it up).

Cases to drive, all with a real mouse drag (programmatic `Range` selection skips the
pointer path):

1. Short selection, fully visible → button above it. Regression check on today's behavior.
2. Select > 1 screenful in the timeline, scroll so the start is off-screen → button below
   the visible end, not pinned to the top.
3. Same, scrolled so the end is off-screen → button above the visible start.
4. Selection taller than the pane, scrolled to the middle → button at the bottom edge of
   the pane.
5. Select in the timeline, scroll until the selection leaves the pane entirely while
   **idle** → button hides. While **speaking** → button parks at the pane edge and still
   stops playback.
6. Selection in the Changes panel (a short pane) → button stays inside the panel and does
   not invert past its far edge.
7. Step 3 only: start playback, scroll far enough to unmount the selected rows, confirm
   audio keeps playing and the button still stops it.

Assert on real geometry, not just presence: read the button's `getBoundingClientRect()` and
check it against the pane's box and the selection's caret rects.

## Outcome

### What shipped

| File                                     | Role                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `read-aloud-placement.ts` **(new)**      | `decidePlacement()` — the table above as pure arithmetic, plus `AnchorRect` |
| `read-aloud-placement.test.ts` **(new)** | 14 vitest cases over that arithmetic                                        |
| `use-selection-anchor.web.ts`            | Geometry only: `text`, `firstRect`, `lastRect`, `visibleBox`                |
| `read-aloud-selection-bubble.web.tsx`    | Owns the widths, calls `decidePlacement`, owns stop intent                  |

Three deliberate departures from the plan as written:

- **The placement table is a pure function, unit-tested.** "Vitest cannot see any of this"
  was only true while the math was tangled with the DOM. Playwright then verifies the
  wiring, not the arithmetic. Five of the seven cases below are also vitest cases.
- **The hook takes a `retainWhileDetached` flag** rather than the bubble retaining a stale
  anchor. Parking at the pane edge needs a _live_ `visibleBox` after the rows unmount, and
  only the hook has the clipping chain. The chain's elements outlive the rows, so it
  re-measures fine with `firstRect`/`lastRect` null.
- **Stop intent is `anchor.text` changing, not `anchor` going null.** The plan's step 3 said
  to keep `handlePointerDown` nulling the anchor _and_ to stop nulling while speaking —
  those collide, and the collision leaves audio playing with no stop control. Resolution:
  outside-mousedown stays an explicit stop, and the bubble's effect keys on the text so a
  replacement selection also stops the previous read. Escape stops and clears the selection;
  it had no handler before.

### The trap the plan missed

Collapsed endpoint clones are the right idea, but **a mouse drag routinely ends at
`(DIV, 0)`** — an element boundary with nothing just inside it — and Chrome returns an empty
rect there. Falling back to `range.getBoundingClientRect()` reintroduces exactly the
container contamination the collapsed clone was avoiding: measured live, that fallback put
the bubble at the pane's _top_ edge for a selection whose visible end was 235px lower.

Fix: when the collapsed clone is empty, resolve the endpoint to the nearest text node the
range actually covers and measure a one-character range there. That walk is O(N), so it runs
once when the selection settles; the resulting `Range` objects are cached and re-measured per
frame. Ranges track DOM mutation, so they stay correct as the virtualizer works, and a
detached one reports zeros — which is precisely the "rects are null" signal step 3 needs.

### Verified in Chrome against the dev stack

Every number below is `getBoundingClientRect()` off the live bubble, checked against the
pane's box and an independent measure of the selection's visible extent.

| Case                                 | Pane   | Measured                                                      |
| ------------------------------------ | ------ | ------------------------------------------------------------- |
| 1. Fully visible                     | 84–765 | bubble bottom 254.5 = selection top 262.5 − 8                 |
| 2. Start scrolled out of the pane    | 84–765 | bubble top 308 = visible end 300 + 8 (was pinned to y=8)      |
| 3. End scrolled out                  | 84–765 | bubble bottom 491.5 = visible start 499.5 − 8                 |
| 3b. Tracking under scroll            | 84–284 | 227/167/107 across three scroll steps, each `visBottom + 8`   |
| 4. Selection taller than the pane    | 84–244 | bubble top 204 = paneBottom − 40, **stable across 5 scrolls** |
| 5. Left the pane, idle               | 84–284 | bubble gone                                                   |
| 5b. Left the pane, speaking          | 84–764 | parked at 92 = paneTop + 8, still "Stop", press stopped it    |
| 6. No room above → flip below        | 84–764 | flipped to 147.5 = firstRect bottom + 8, never past the edge  |
| 7. Selected subtree removed mid-read | 84–764 | selection gone, bubble stays at 724 = paneBottom − 40, stops  |

Plus the stop-intent rules: a new selection while speaking stops the previous read, Escape
stops and dismisses, and an outside click stops.

**The Changes panel is the only surface with a multi-level chain**, and it is the one that
proves `visibleBox` is doing real work. Selecting a diff line resolves **seven** clipping
ancestors — the horizontally scrollable code column (`overflow-x: auto`, 356–800), the file
body, `git-diff-scroll` (`overflow-y: auto`, 120–901), and three more `hidden` wrappers up to
the root — intersecting to `{top 155, bottom 901, left 356, right 800}`.

| Changes-panel case           | Measured                                                               |
| ---------------------------- | ---------------------------------------------------------------------- |
| Select a diff line           | no room above → below at 197 = selection bottom 189 + 8                |
| x-clamp basis                | left 364 = **code column** left 356 + 8 — not the window, not the pane |
| Scroll the code column right | selection left ran 378 → 298 → 178; bubble held at 364, never left it  |
| Scroll the diff pane past it | bubble gone (idle)                                                     |

The horizontal-scroll row is the clearest evidence for bug 2's x-axis half: the old
`window.innerWidth` clamp would have let the bubble follow the text out of the code column
and over the sidebar.

Case 7 was driven by removing the selected subtree from the DOM rather than by scrolling far
enough to trip the virtualizer's `overscan: 8` — the test conversation is not long enough to
unmount rows. The mechanism is the same one the virtualizer exercises (the range's nodes
detach), but a long-conversation run is still worth doing once.

### Accepted, documented

A selection with a large unselected gap in its middle can put the bubble over unselected
content in case 4. Anchoring to `visibleBox` buys stability under scroll and O(1) cost
exactly when the selection is largest; a mid-selection rect would jitter and cost O(N).
