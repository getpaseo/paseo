# Mobile panels

Compact layouts have three mutually exclusive destinations:

- `agent-list` on the left
- `agent` in the center
- `file-explorer` on the right

They are one interaction, not two independent drawers. The implementation lives in
`packages/app/src/mobile-panels/`.

Wide layouts reuse `agent-list` for the navigation overlay. When the left dock is collapsed or
yields its width, a touch swipe reveals the same sidebar over the workspace at the resolved sidebar
width. The workspace does not move, and the saved dock preference does not change.

## Ownership

React/Zustand owns the durable intent:

```ts
interface MobilePanelSelection {
  target: "agent-list" | "agent" | "file-explorer";
  revision: number;
}
```

Every semantic target change increments `revision`. Repeating the current target is idempotent.
Compact panel selection is not persisted; a cold start begins at `agent`.

An overlay sidebar holds `agent-list`, and only a compact layout holds `file-explorer`.
A compact Settings visit entered from the sidebar suspends it: the host stays mounted and
laid out on native. Its target and scroll position survive until return to the originating
workspace. Route changes and `onLayout` both precede native screen appearance, so the sidebar
stays visible until Settings emits the native navigator's `transitionEnd`. Web uses layout.
Input and activity stop during the handoff. Widening or leaving for another destination discards
the return. Commands issued while suspended settle immediately behind Settings, so explicit
agent navigation does not reveal a closing sidebar animation.

App chrome publishes the layout (compact or wide, and the left sidebar presentation `overlay`,
`dock`, `hidden`, or `suspended`) to `panel-store`, which drops any target the layout does not present. A stale
`agent-list` would reopen the overlay on the next collapse; a stale `file-explorer` after widening
would block the navigation swipe, which begins only from `agent`.

The UI worklet owns transient motion:

- one normalized position (`-1` left, `0` center, `1` right)
- the current motion target
- the active gesture's starting revision
- the last settled target

React publishes the active panel only when the canonical target and the UI-thread position agree at
the final anchor. Retained content never observes gesture previews, progress, or an unsettled target.
The gesture hosts stay mounted. A pointer capture on a paragraph confines browser selection to that
paragraph, so the Gesture Handler web patch keeps it off: initially disabled hosts register no
pointer listeners, and an enabled host captures only a pointer its handler still tracks after
pointer-down. The touch-only navigation pans fail a mouse at pointer-down and never capture it.
Native worklets own overlay opacity and pointer events while
React owns settled panel activity and accessibility. Keep hidden native overlays laid out: collapsing
their scroll ranges makes Android spring retained offsets back to zero during touch cancellation or
release. Native panel hosts and their dependent draggable lists
also retain identity across appearance hydration and settings changes. Do not wrap those hosts in
appearance keys; see [Unistyles appearance boundaries](unistyles.md#runtime-theme-patching-for-user-preferences).

## Why one position

Both transforms and both backdrop opacities are derived from the same normalized position. Panel
width is only a projection input: the window width on the right, and on the left the width
`MobilePanelsProvider` resolves (the full window on compact layouts, the saved sidebar width
clamped to the viewport on wide ones). The dock, the overlay, and their gestures read that one
value. Rotation changes the projection, not the panel state.

This makes these invalid states unrepresentable:

- a panel and its backdrop disagreeing
- left and right drawers both claiming to be open
- a width-sync effect resetting an active drag
- one animation context settling a transition owned by the other

Do not add another panel translate shared value, backdrop shared value, or width synchronization
effect.

## Ordering and interruption

A gesture captures the current revision when it becomes active. Per-frame updates are accepted only
while that revision still owns the gesture.

When a React command arrives during a drag, its newer revision clears gesture ownership and starts
motion toward its target, even an unchanged one: docking mid-swipe keeps `agent` and still returns
the dragged position to its anchor. The older gesture's remaining updates and finish callback are
ignored.
Canceled gestures return to the latest canonical target. A successful gesture starts its finishing
motion immediately; the matching React command adopts that motion instead of restarting it. Position
settlement and command acceptance may arrive in either order. Activity changes after both agree on
the same target.

Manual gesture arbitration has two phases:

1. Before activation, determine whether horizontal intent may begin.
2. After activation, stop running begin checks and let the active revision own updates.

Re-running the begin gate after activation self-cancels the gesture because an active gesture is, by
definition, no longer eligible to begin.

## Integration rules

- Callers request semantic targets through `panel-store`; they never write shared values.
- Gesture behavior comes from the four explicit hooks in `mobile-panels/gestures.ts`.
- Navigation gestures accept touch pointers only. Mouse and pen fail at touch-down, so dragging a
  mouse to select text on a hybrid laptop never moves a panel. Browsers without a touch screen
  (`hooks/pointer-capabilities`) never enable them.
- Phone web opens a drawer only from the 32px edge it slides in from, so interior swipes stay with
  terminals, code blocks, and diff scrollers. Native drawers and the wide overlay open from anywhere.
  Horizontal-scroll ownership and the open-gesture blocker still take precedence.
- A focused interactive surface may block panel-opening gestures through
  `useBlockMobilePanelOpenGestures`. Register only while the conflicting interaction is active and
  unregister when the surface is hidden or unfocused. The blocker never disables gestures that close
  an already-open panel.
- Keep `SidebarModelProvider` outside `MobileGestureWrapper`. The provider shares sidebar derivation
  across consumers, while Gesture Handler requires the wrapper's direct child to be a native `View`
  so its injected `collapsable={false}` reaches Android/Fabric.
- Sidebars render through `MobilePanelOverlay`; do not duplicate overlay lifecycle or motion styles
  in sidebar components. The wide left sidebar keeps the same content and gesture hosts when switching
  between dock and overlay. App chrome owns mounting and presentation; settled panel activity owns
  overlay work. A hidden dock is inactive with `display: none`; the sidebar tree stays mounted. Keep
  the native overlay laid out while hidden, as on compact layouts. Give the switching host no
  Reanimated layout props: a width keyed on the presentation reaches Android after React commits the
  switch, and a lost update left the workspace at the dock width. The dock sizes to its content and
  the overlay host fills the window.
- The overlay's backdrop covers the whole window; safe-area padding applies to the sidebar and
  workspace content only. It closes by swiping back, tapping the backdrop, or picking a destination:
  workspace destinations close the overlay before navigating. Settings suspends the compact
  sidebar for the duration of its visit instead.
- Animated panel nodes use React Native static styles plus inline theme values. Do not attach
  Unistyles-generated styles to those nodes; Unistyles and Reanimated patching the same Fabric node
  has caused native crashes.
- `FORCE_REACT_RENDER_FOR_SETTLED_ANIMATIONS` stays off in `packages/app/package.json`. It is a
  compile-time flag; changing it needs a native rebuild. With it on, Reanimated 4.3 hands settled
  animated props back to React through a collector that forgets entries older than two seconds. A JS
  stall across a panel settle loses the final position, and the next React commit reverts the overlay
  to its last synced props: a backdrop over the workspace while the store says closed. Upstream fixed
  the collector in 4.4.3, which needs React Native 0.83.
- Gesture start and progress must not update React state. The retained overlay is already mounted and
  offscreen; only the shared position and its derived native styles move during a drag.
- Hidden tabs and workspaces use `RetainedPanel`. It owns a non-collapsible native root, visibility,
  pointer events, and the active signal consumed by `useRetainedPanelActive`.
- Panels whose gesture wrapper already owns visibility use `RetainedPanelActivity` to provide the
  same active signal without adding another layout root. Persistent animations, timers, polling, and
  shared clocks must subscribe to that signal and stop when their final visible consumer leaves.
- Synchronized step animations use one wall-clock-aligned source. Register a local shared value only
  while its retained panel is active so hidden animated styles remain mounted without receiving clock
  updates. Do not give every instance its own loop or leave hidden styles subscribed to the source.
- Retention order and render order are separate concerns. LRU metadata may change on every switch;
  keyed retained roots must keep a stable sibling order. Moving large retained roots triggered Fabric
  Differ failures (`addViewAt` / `removeViewAt` view reuse) on Android.
- `useIsMobilePanelActive` follows the settled target, not the requested target. Position at the
  canonical target's anchor is the settlement signal; animation duration and completion callbacks
  do not own activity. Cancellation publishes nothing.
- Do not suspend retained native subtrees with `Suspense`/`react-freeze`. Suspension changes native
  ownership and can detach descendants. Keep the tree mounted, stabilize its subscriptions/selectors,
  and use the retained-panel active signal to stop timers, polling, and other genuine background work.
  Hidden chat content is suspended on web only, through `retained-chat-content.web.tsx`, where DOM
  nodes carry no Fabric ownership; the native file keeps the chat live.

## Tests

`packages/app/src/mobile-panels/model.test.ts` exercises command, drag, cancellation, interruption,
rapid-command, position-settlement, and width-projection sequences through the transition model. Add
a sequence there whenever ownership or ordering changes.
