# Floating Panels

Anchored popovers — tooltips, hover cards, dropdowns, autocompletes — that visually
float above an anchor element on iOS, Android, and web. This doc captures the
non-obvious traps. It is **not** a tutorial; it assumes you have seen the
canonical files and are trying to add or change one.

## Canonical files

| File                                     | Use case                                                          |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `components/ui/combobox.tsx`             | Anchored picker with search; mobile falls back to bottom sheet    |
| `components/ui/tooltip.tsx`              | Non-interactive hover/long-press tooltip                          |
| `components/workspace-hover-card.tsx`    | Desktop-web hover card with measure + computePosition + Portal    |
| `components/ui/autocomplete-popover.tsx` | Slash-command autocomplete anchored to the focused composer input |

Each handles a different mix of concerns: combobox owns input focus, tooltip is
non-interactive, hover-card is web-only desktop, autocomplete keeps the composer
input focused while its scrollable list lives in a Portal. There is no shared
"floating panel" primitive yet — when a fifth use case shows up we can revisit;
until then prefer copying the closest file and trimming.

## Popover width contract

Combobox desktop popovers are never narrower than their trigger, and they grow
with content up to a ceiling that is never below the trigger:

```ts
const floor = Math.max(desktopMinWidth ?? 0, referenceWidth ?? 200);
const frameStyle = { minWidth: floor, maxWidth: Math.max(400, floor) };
```

`desktopMinWidth` is an explicit floor-raiser. It does not cap width, and the
trigger still wins when it is wider. Changing this default requires re-verifying
every consumer listed here.

Consumers: `composer/agent-controls/mode-control.tsx`,
`composer/agent-controls/index.tsx`, `composer/index.tsx`,
`components/combined-model-selector.tsx`, `components/hosts/host-picker.tsx`
(including `components/hosts/host-filter.tsx`), `components/branch-switcher.tsx`,
`components/left-sidebar.tsx`, `components/ui/select-field.tsx` (schedule form),
`screens/new-workspace-screen.tsx` plus `screens/new-workspace/project-picker.ts`,
`components/import-session-sheet.tsx`, `screens/workspace/workspace-screen.tsx`,
`screens/settings-screen.tsx`, and `screens/project-settings-screen.tsx`.

## Gotcha 1 — Android touch hit-test by parent bounds

On Android, a child View whose bounds fall outside its parent's bounds renders
correctly (with `overflow: visible`, the default) but **does not receive touch
events**. `ViewGroup.dispatchTouchEvent` filters touches by the parent's hit
rect first, then iterates children. A touch in the overflowing region never
reaches the parent, let alone the child. iOS and web do not share this rule —
iOS hit-test descends into overflowing children, web uses standard CSS pointer
events. This is the bug that put autocomplete on this path: the popover was
positioned `bottom: 100%` of its parent and worked on iOS/web for months;
Android touches sailed straight through to the chat scroll view behind it.

Two escape hatches in the codebase:

- **`Modal`** (combobox, dropdown menu and tooltip on native) — opens a new Android window, so
  hit-testing starts fresh in that window. Side effect: a Modal opening on
  Android can detach the IME from an underlying TextInput. Fine for combobox
  (it has its own input) and tooltip (no input). **Not** fine for autocomplete
  (the composer's input must stay focused so the user keeps typing).
- **`<Portal>` from `@gorhom/portal`** (hover-card, autocomplete-popover) —
  hoists the React subtree to a fixed mount point whose bounds cover the
  screen. Same window, same IME, hit-test works because the new parent is
  full-screen. This is the right default when you must keep IME attachment.
  Choose the host by layer: app-global overlays use the root host; content
  overlays can use the current `FloatingPanelPortalHost` so sliding sidebars
  cover them.

  Choose Modal vs Portal by whether the underlying input can lose its keyboard.

On web, dropdown menus render into the shared `overlay-root`, not React Native
Web's `<Modal>`/`<dialog>`. A browser top-layer dialog always paints above
ordinary portals regardless of `z-index`, which would hide app toasts and
tooltips behind the menu. The shared overlay scale keeps menus below toasts and
lets tooltip portals paint above both.

The shared overlay scale is relative for interactive surfaces: a base floating
panel is below a base modal, while a floating panel rendered from inside a modal
inherits that modal's layer and paints above it. Wrap portal content in
`OverlayLayerProvider`; do not assign one global menu z-index. Desktop web
comboboxes must use `overlay-root` too. Rendering them through React Native
Web's `<Modal>` puts them in the browser top layer, where no ordinary modal
portal can cover them.

Painting and keyboard ownership use the same relative layer model. Register
desktop modal, combobox, and dropdown focus scopes with `useWebOverlayRegistration`; the
highest painted scope alone receives overlay keys, traps focus, and restores
focus when it closes. Do not add component-local global Escape listeners: two
stacked overlays would both close on one keypress.

If an overlay is rendered by a global host rather than beneath its opener in
the React tree, carry the opener's current layer through the host store and
restore it with `OverlayLayerProvider`. Otherwise painting and keyboard
ownership silently reset at the app root. When the opener is a global keyboard
action and has no component context to carry, resolve the host layer with
`useGlobalWebOverlayLayer` on its closed-to-open transition. It captures the
current top registered layer before the new host joins the stack; do not give a
global dialog a fixed root-derived modal layer.

## Gotcha 2 — Portal breaks lifecycle and coordinate-system inheritance

A Portal escapes Android's hit-test, but it also escapes two things you were
quietly relying on:

- **Lifecycle.** The portal'd subtree mounts at the app root, not inside your
  component's natural ancestor chain. When the user navigates away, your
  component may stay mounted (offscreen, in a tab) — the popover stays with it.
  Gate `visible` on a screen-focus signal. For panes inside `agent-panel`, the
  `isPaneFocused` prop already exists and flips on pane switches; pass
  `visible={isYourOwnVisible && isPaneFocused}`.
- **Transforms.** `KeyboardShiftProvider` owns the canonical keyboard shift
  SharedValue, and `useKeyboardShiftStyle()` only adapts that value into
  translate/padding styles. The composer and chat content must both read that
  provider-owned value. A portal'd popover is outside the composer tree — it
  does not get that transform unless you apply it yourself.
- **Layering.** The default root host renders after app content, so it sits
  above compact sidebars. Content overlays that must sit below sidebars should
  use the current `FloatingPanelPortalHost`.
- **Coordinate systems.** `measureInWindow` gives window coordinates. A Portal
  renders inside its host, not necessarily at window origin. Position anchored
  content relative to the host: `anchorRect - hostRect`. This is what
  `measureFloatingPanelPortalHost()` is for.
- **React context.** `@gorhom/portal` is not a React portal — a real one keeps
  context, this one does not. It stores the element and the host renders it, so
  context resolves at the _host's_ position. Everything provided between
  `PortalProvider` in `app/_layout.tsx` and your sheet is invisible inside it.
  This is why app-wide providers wrap `PortalProvider` rather than the reverse.

The fix for transforms is Gotcha 3. The fix for context is Gotcha 7.

## Gotcha 3 — Keyboard layout and portal anchors

`KeyboardTranslateView` owns visual keyboard motion. Android uses the
controller's Reanimated signal. iOS uses its native-driver `Animated.event`
signal because the stock iOS Reanimated value changes at move start, while
writing a replacement Reanimated value every frame interrupts UIKit's hide
animation. Keep this platform choice inside `KeyboardTranslateView`.

`KeyboardDock` always keeps the chat surface at full height and wraps it in
`KeyboardTranslateView`. The panel root clips it at the header edge, so rows
slide under the header on open and out from under it on close. Do not swap the
dock to keyboard padding at rest. Changing its height creates either a blank
band or a paused transition when the inverted list updates its viewport.

Do not animate a layout prop through the keyboard transition. On Android
Fabric, each animated layout update clones the shadow tree and runs Yoga over
the dock subtree. This measured about 10 ms per frame on the emulator and the
mounted layouts arrived in bursts every 2–4 frames. A transform does not dirty
layout. Preserve the translated dock's history scroll range with a far-end
content inset on the inverted stream list. Update that inset only when keyboard
motion settles; never drive it per frame.

Move the stream and composer together through `KeyboardDock`. Do not translate
them independently.

`KeyboardShiftProvider` owns the normalized shift used for settled insets and
portal geometry, plus the `isMoving` worklet value. It reconciles native
animation-end events because the controller can retain a nonzero value after
the keyboard closes.

Measure portal anchors while the dock is at rest. If a popover opens during
motion, re-measure when `isMoving` settles. `measureInWindow` includes the
dock's current layout and transform. Snapshot the shift at measurement time and
apply only the subsequent shift delta to the animated `bottom`. Adding the full
shift moves the portal twice and can place it over the composer controls.

The provider also reconciles iOS from the controller's native `onEnd` event.
The controller's stock iOS shared values update at move start and during an
interactive move, but not at the terminal event, so JS contention can otherwise
leave the last height/progress pair stuck in either the open or closed state.
Keep that terminal reconciliation on the UI thread; a later focus or blur must
not be required to repair the offset.

## Gotcha 4 — Host-relative positioning before platform offsets

The generic anchored-overlay rule is:

1. Measure the anchor with `measureInWindow`.
2. Measure the Portal host with `measureFloatingPanelPortalHost(hostName)`.
3. Position with anchor coordinates relative to the host:

```ts
left = anchorRect.x - hostRect.x;
bottom = hostRect.height - (anchorRect.y - hostRect.y) + offset;
```

Do this before adding any platform offset. If anchor and host are both measured
with `measureInWindow`, Android's status-bar coordinate behavior cancels out.
Only add a status-bar offset when the render surface is not measured in the same
coordinate system. See `tooltip.tsx` for that separate case.

## Gotcha 5 — The two-measurement flash

If your popover needs `top` (or `left`) computed from both:

- the anchor's screen position (`anchorRect` from `measureInWindow`), **and**
- the popover's own size (`contentSize` from `onLayout`),

then a naïve implementation will flash through three positions on every open:

1. **Frame 1** — render with `top: -9999` (or any placeholder) while waiting
   for either measurement. Wrapper has no `width`, so the inner content lays
   out at its natural (often narrow) intrinsic width.
2. **Frame 2** — `anchorRect` lands. Wrapper now has `width: anchorRect.width`.
   But the stale `onLayout` from frame 1 has already set `contentSize` to the
   narrow-width dimensions. `top = anchorRect.y - wrongHeight - gap` — visible
   at the wrong spot.
3. **Frame 3** — real `onLayout` fires with the correct width. `contentSize`
   updates. Position snaps to the right place.

The visible jump in frame 2 is the flash. Two pieces solve it, and you need
both:

- **Do not mount the floating content until `anchorRect` is set.** Return
  `null` until then. This prevents the bad-width onLayout from happening at
  all.
- **Once `anchorRect` is set but `contentSize` isn't, render the wrapper with
  the final width but `opacity: 0`.** The first visible paint is at the
  correct position. This is the combobox pattern —
  `shouldHideDesktopContent` at `combobox.tsx:481, 876`. **Do not** use
  `top: -9999` as the placeholder; the layout work still happens at -9999 and
  any subsequent state-flash is visible when you flip back.

The "render invisible to measure, then reveal" pattern is the canonical
solution to chicken-and-egg positioning in this codebase. Reach for it before
anything fancier.

## Gotcha 6 — Bottom sheet refs are not lifecycle truth

`@gorhom/bottom-sheet` modals churn their imperative ref while presenting and
dismissing. Do not treat `ref != null` as permission to call `present()`, and do
not treat `ref == null` as the sheet being closed. The user-visible lifecycle is
the desired `visible` prop plus the sheet callbacks (`onChange(-1)`,
`onDismiss`).

If a user closes a sheet with the backdrop or a pan gesture, the sheet may detach
and reattach before React state has acknowledged `visible=false`. Re-presenting
on that attach races Gorhom's dismiss path and leaves the modal unable to reopen.
Track an explicit phase (`closed` / `presenting` / `presented` / `dismissing`) and
ignore ref churn while dismissing.

Do not treat `onChange(-1)` as a close by itself. In a stacked
`BottomSheetModal`, `-1` can also mean the sheet is temporarily hidden under
another pushed sheet. Close React state from `onDismiss`; use `onChange` only to
track phase.

## Gotcha 7 — A sheet cannot read context from its call site

React cannot copy contexts reflectively, so the only way across the teleport in
Gotcha 2 is to render the providers a second time, with values captured on the
near side where they are still readable. `IsolatedBottomSheetModal` takes a
`contextBridge` for exactly that:

```tsx
const contextBridge = useCallback<ContextBridge>(
  (content) => <ThingContext.Provider value={thing}>{content}</ThingContext.Provider>,
  [thing],
);
```

The prop is **required**, and `null` is a real answer. A sheet whose content
needs nothing local should have to say so, because the failure mode is silent
until someone adds a `useContext` deep inside and it throws on device only —
never on web, where the desktop path uses a real portal. `menu-surface.tsx`
bridges the menu's two contexts; the rest pass `null`.

Wrapping providers _around_ the modal does nothing. They land on the wrong side.

## Recipe for a new anchored panel

Before you write a new one, ask:

1. **Can the underlying input lose its keyboard?** If yes, use Modal (simpler).
   If no, use Portal.
2. **Does the panel need to dismiss on screen change?** Almost always yes —
   gate `visible` on an upstream focus prop (`isPaneFocused` or similar).
3. **Is the panel rendered in a Portal host?** Measure the host too. Never use
   raw window coordinates as local Portal coordinates.
4. **Does the panel sit above something that moves with the keyboard?** If
   yes, slave a Reanimated transform to the same SharedValue (Gotcha 3).
   If no, you can probably skip the transform entirely.
5. **Will the panel's content height vary?** If yes, you need both
   `anchorRect` and `contentSize` for positioning → apply Gotcha 5 (return
   null until anchor, then opacity-0 until contentSize). If no — content has
   a known fixed max height — you might be able to use bottom-anchored
   positioning (`bottom: windowHeight - anchor.y + gap`) and skip the
   `contentSize` round-trip entirely. **But only if the height is genuinely
   bounded**. Verify before you commit.

Then copy the closest canonical file and trim.

Building a **menu** rather than a bare panel? Don't. Use the menu engine — it already solves
everything above, plus submenus, sheets, and hover intent. See [menus.md](menus.md).
