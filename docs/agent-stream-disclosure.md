# Agent stream disclosures

Expanding or collapsing something in the chat timeline (a turn's summary line, a tool-call group,
a tool call's inline details, a todo card) keeps the tapped trigger at the same screen y in the
first painted frame. No animation.

## The contract

A disclosure component knows nothing about the list. It wraps its state change:

```tsx
const hold = useDisclosureHold();
const handleToggle = () => hold(() => setExpanded((value) => !value));
```

`view.tsx` wraps every timeline row in `DisclosureRow`, which routes `hold` to the strategy's
`holdRow(rowId, apply)` (`packages/app/src/agent-stream/disclosure.tsx`). Outside a timeline row,
`apply` runs as is. The strategy owns when `apply` runs and how the row keeps its place.

Following output:

- A hold always detaches the bottom anchor controller (`holdForDisclosure`).
- When the hold ends, the controller re-sticks only if the list sits at its end and no user scroll
  owns the viewport (`releaseDisclosure({ isAtEnd })`). Expanding at the bottom therefore leaves
  the list detached with the scroll-to-bottom pill showing; collapsing back to the end resumes
  following.
- Scroll events during the hold never re-stick: the correction is a programmatic scroll that
  would otherwise read as "back at the bottom".

The trigger can only stay put when the list has scroll room for the change. When the loaded
content fits the viewport, or a collapse at the end would need an offset past the end, the list
ends at its end and the trigger moves by the difference. On iOS the correction first lands past
the end and the re-stick pulls it back a few frames later.

## Web

`holdRow` pins the row in the reading anchor and runs `apply`; the next reading reconcile restores
the row's top after layout, before paint (`strategy-web.tsx`).

## Native

On compact layouts, tool calls and tool-call groups open a sheet instead of expanding, so they do
not hold. Summary lines and todo cards expand inline.

The ScrollView's `maintainVisibleContentPosition` does the work: it picks an anchor view at the
start of a mount transaction and scrolls by that view's movement once the transaction lands, in
the same frame. `useNativeDisclosureHold` (`native-disclosure-hold.tsx`) drives it in three
commits, each in its own UI frame:

1. **Anchoring.** Point `minIndexForVisible` at the held row's older neighbour.
2. **Applied.** Run `apply`. The helper corrects the offset in the frame that shows the change.
3. **Release.** Drop the anchor, report `isAtEnd` to the controller.

### Why the older neighbour

The list is inverted, so a row's older neighbour sits directly above it on screen and its native
top edge is the trigger row's visual top. The trigger's own view changes size; the neighbour only
moves. A trigger in the live head anchors the newest history row.

### Native child index

`minIndexForVisible` is an index into the ScrollView's native children, not into the data:
header (the live head), one view per rendered cell, then the footer. VirtualizedList's spacers for
unrendered rows are height-only Views that Fabric flattens away (verified on RN 0.86: the
`View` shadow node has no events or transform, so it does not form a native view, and counting
spacers missed the anchor on device). So the index is 1 + the mounted rows newer than the
neighbour (`native-disclosure-anchor.ts`). The mounted set comes from a registry each rendered
cell joins in a layout effect.

Overcounting is not safe. When the held row is the oldest mounted row its neighbour is the footer,
the last child; one extra and the index matches no child, and Android keeps its previous anchor.

### Frame spacing

`apply` runs two frames after the anchoring commit, and the release two frames after the applied
commit. Do not shorten this to one commit or one frame. Android merges every Fabric commit
queued before the next UI frame into one mount transaction, and the helper picks its anchor at the
start of a transaction: with the config and the change in one transaction, nothing is anchored.

Frames are counted from each commit's layout effect, not from the state change. React can render
a large toggle after the next animation frame has already fired; counting from `setState` then
lands two commits in one transaction again.

### FlatList's own prop

FlatList's `maintainVisibleContentPosition` is `undefined` during the hold, and the anchor goes to
the ScrollView through `renderScrollComponent`. VirtualizedList reads that prop in data-index space
and refreshes its anchored item key only when the row count changes, so setting it at hold time
shifts the render window by the wrong amount.

`renderScrollComponent` is passed on every render. Switching between a function and `undefined`
remounts the ScrollView, which lands the list at its end.

The hold config has no `autoscrollToTopThreshold`. With it, Android smooth-scrolls to the end
instead of anchoring.

### Render window

VirtualizedList keeps its render window by index. Rows inserted or removed newer than the trigger
shift the held row and its neighbour out of the window, and they would unmount in the applied
commit, taking the anchor view with them. For that commit only, `initialNumToRender` is raised so
the initial region covers every row from the newest down to the oldest row mounted at hold time.
The initial region is always rendered and is recomputed on a count change. VirtualizedList has no
cheaper lever: its own MVCP window shift is keyed as above, and sticky headers do not apply.

Cost: the applied commit mounts every row between the newest row and the window, including every
row the expansion inserts. Measured on the Android emulator with a dev build:

| Toggle                                                          | Applied commit (JS) | Slowest UI frame |
| --------------------------------------------------------------- | ------------------- | ---------------- |
| Summary line at the bottom, short turn                          | 0.29 s              |                  |
| Summary line ~14,000 px up (window start > 0), expand           | 0.94–1.42 s         | 0.40–0.95 s      |
| Same, collapse                                                  | 0.85 s              | 0.67 s           |
| Summary line mid-screen at the bottom, 15,000 px turn, anchored | 0.7–3.5 s           | 0.29–0.72 s      |
| Same toggle without the anchor                                  | 0.26 s              | 0.10–0.19 s      |

That is a visible hitch on long turns and deep positions. Rendering a turn's expanded content
inside one row instead of as separate rows would remove the index shift and the bump with it.

### Content clamp

`ReactScrollView` clamps its offset to the new maximum during a mount when the content shrinks
below it, and the helper then adds its correction on top of the clamp. A collapse near the oldest
history moved the trigger by the collapsed height twice. During the hold, the content container
carries extra bottom padding (native bottom is the visual top) equal to the offset plus the
viewport height, so the content cannot shrink below the offset. The padding moves no child, and
releasing it leaves the corrected offset valid.
