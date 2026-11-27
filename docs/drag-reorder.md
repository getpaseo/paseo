# Drag to reorder

A list the user can reorder renders through `DraggableList` from `@/components/draggable-list`. Each row puts a `DraggableListHandle` where its grip is drawn. The Usage cards (`packages/app/src/usage/list.tsx`, `packages/app/src/usage/card.tsx`) and the agent profile roster (`packages/app/src/agent-profiles/settings/`) are the reference.

| Platform | How a drag starts                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web      | dnd-kit pointer drag. With `useDragHandle`, only the handle starts it, and the handle reorders by keyboard. Without it, the whole row starts it. |
| Native   | Hold the handle for 180 ms without moving more than 4 px. The list then owns the touch until the finger lifts.                                   |

## The scroll view must host the drag

On native, the hold calls `drag()`, which calls `useContentDrag().setActive(true)` from `@/components/ui/content-drag` on the nearest scroll view. That scroll view stops scrolling until the drag ends. If no scroll view up the tree hosts content drags, `setActive` does nothing. The page scroll then takes the touch as soon as the finger moves past the touch slop, before the list's own pan activates. The row never moves, and the page scrolls instead.

These scroll views host content drags:

- `ScrollView` from `@/components/ui/scroll-view`, inside and outside a sheet.
- `PageLayout`, for a settings page or any other full page.

If you put a reorderable list in another scroll view, such as a third-party keyboard-aware one, wrap it with `withContentDrag` from `@/components/ui/content-drag`. `packages/app/src/components/page-layout/index.tsx` shows the pattern. A plain `ScrollView` from `react-native` breaks the drag.

Inside a sheet, the `ScrollView` also registers the drag gesture with the sheet, so the sheet's pan-to-close waits for it.

## Where the grip goes

The grip hangs in the row's leading padding, absolutely positioned over the full row height. The row's content keeps the same left rail as rows that cannot be reordered, and the grip does not take a column. On a pointer device the grip shows on hover, focus, or while dragging. On touch and compact layouts it always shows, because there is no hover.

## Test with a page that scrolls

A list that fits on the screen does not show the bug, because the page has nothing to scroll. Test on a phone with enough rows that the page scrolls. Then check both directions:

1. Hold the grip and drag a row past two others. The new order is saved.
2. Swipe quickly on a row body. The page scrolls and the order stays the same.

On an Android emulator, `adb shell input swipe` does not hold still long enough to arm the drag. Send `input motionevent DOWN`, wait 500 ms, then send `MOVE` events and `UP`.
