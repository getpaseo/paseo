# Mobile panels

Compact layouts have three mutually exclusive destinations:

- `agent-list` on the left
- `agent` in the center
- `file-explorer` on the right

They are one interaction, not two independent drawers. The implementation lives in
`packages/app/src/mobile-panels/`.

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

The UI worklet owns transient motion:

- one normalized position (`-1` left, `0` center, `1` right)
- the current motion target
- the active gesture's starting revision
- the last settled target

React also owns presentation lifecycle: whether an overlay is mounted/displayed and whether it may
receive pointer events. Worklets never own `display` or `pointerEvents`.

## Why one position

Both transforms and both backdrop opacities are derived from the same normalized position. Window
width is only a projection input. Rotation changes the projection, not the panel state.

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
motion toward the new target. The older gesture's remaining updates and finish callback are ignored.
Canceled gestures return to the latest canonical target. Animation completion is accepted only when
its target and revision still match the canonical command.

Manual gesture arbitration has two phases:

1. Before activation, determine whether horizontal intent may begin.
2. After activation, stop running begin checks and let the active revision own updates.

Re-running the begin gate after activation self-cancels the gesture because an active gesture is, by
definition, no longer eligible to begin.

## Integration rules

- Callers request semantic targets through `panel-store`; they never write shared values.
- Gesture behavior comes from the four explicit hooks in `mobile-panels/gestures.ts`.
- Mobile sidebars render through `MobilePanelOverlay`; do not duplicate overlay lifecycle or motion
  styles in sidebar components.
- Animated panel nodes use React Native static styles plus inline theme values. Do not attach
  Unistyles-generated styles to those nodes; Unistyles and Reanimated patching the same Fabric node
  has caused native crashes.
- The plain React wrapper owns `display: none` after settlement. This prevents a stale Fabric animated
  prop commit from resurrecting a closed overlay.

## Tests

`packages/app/src/mobile-panels/model.test.ts` exercises command, drag, cancellation, interruption,
rapid-command, stale-completion, and width-projection sequences through the transition model. Add a
sequence there whenever ownership or ordering changes.
