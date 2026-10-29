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
| `components/ui/hover-card.tsx`           | Desktop-web hover card the pointer can move onto; Portal          |
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
  hit-testing starts fresh in that window. If its children use gesture-handler,
  the Modal owner must wrap its content in a full-height `GestureHandlerRootView`:
  the app's root does not span Android windows. React context alone does not
  establish a native gesture root. Side effect: a Modal opening on
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
focus when it closes. Hover cards register with `manageFocus={false}`: they claim overlay keys without moving or trapping focus on pointer hover. Do not add component-local global Escape listeners: two
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
- **Transforms.** The composer moves with the keyboard through a
  `KeyboardTranslateView` transform. A portal'd popover is outside that view, so
  it does not move with the composer unless it renders its own
  `KeyboardTranslateView` with the same translation.
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

`composer/dock` owns the stationary viewport, bottom-anchored surface, composer
capacity, and keyboard motion for chat, workspace draft tabs, and New workspace.
Render `<ComposerDock>{contentAbove}{composer}</ComposerDock>` below the header.
The optional third child is an overlay that moves with the surface. New workspace
uses `centered` for its existing desktop/tablet form. Hosts never reserve keyboard
space or translate the composer themselves. Put the dismiss surface behind content
as a sibling, with `pointerEvents="box-none"` on its content wrapper. A Pressable
ancestor takes the JS responder on idle Android Fabric and intercepts the stream's
MOVE events before its native scroll view reaches touch slop. Streaming can hide
this failure by delaying the responder grant. Native scroll views retain their own
tap-to-dismiss behavior; unclaimed empty-space taps reach the dismiss sibling.
On iOS, decorative form containers also need `box-none` (and inert titles/spacers
need `none`); otherwise their empty padding blocks hit testing of that sibling.
The shared screen header uses the same dismiss surface. Keep the
header escape available when a capped draft clips all content above it, since
iPhone has no system keyboard-dismiss button. Child controls keep their touches,
and the stream keeps its existing flick-to-dismiss gesture.

The dock's private viewport and capacity model are extracted from chat. The
app-wide `@/keyboard/shift` module owns shared motion for the dock, portals, streams,
terminal, explorer, and dialogs. Import only its public entry point: the provider,
shift hooks, shift style, translate view, keyboard anchor, settled stream inset, and explorer padding
policy. Its contexts and reconciliation stay private. Keep `KeyboardShiftProvider`
at its root mount point outside the portal host when changing dock hosts.

`KeyboardTranslateView` owns visual keyboard motion inside `@/keyboard/shift`. Android uses the
controller's Reanimated signal. iOS uses its native-driver `Animated.event`
signal because the stock iOS Reanimated value changes at move start, while
writing a replacement Reanimated value every frame interrupts UIKit's hide
animation. Keep this platform choice inside the keyboard module's private platform-specific translate files.

`ComposerDock` always keeps the surface at full height and wraps it in
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

The translated dock's height is not the composer's available height. Bound the
composer against the stationary space below the header inside
`composer/dock`, including its controls and attachments. Reserve the
keyboard destination at move start on the UI thread. Waiting for a settled JS
update lets a long draft disappear behind the header during opening. This is a
boundary-time layout change, not an animated layout prop. Keep the input's
native intrinsic sizing and internal scrolling. Keep the editing input's
`defaultValue` current on every edit: Fabric re-measures the Android input from
the JS text whenever its frame changed, so a stale prop inflates or collapses
the input (see `packages/app/src/components/ui/text-input/text-input.native.tsx`).

Closing the keyboard moves the composer; it does not enlarge its capacity. The
viewport keeps the last keyboard reservation until the next opening replaces
it, so a capped draft keeps one height through every keyboard transition
instead of expanding on close and shrinking again on open.

Fullscreen is a layout mode of the dock, not a second editor. `ComposerDock
fullscreen` fills the stationary viewport with the composer slot over the
still-mounted content, paints its own surface under the safe areas, and turns
the surface translation off. The composer's single tree keeps the editing
surface at the same position in both modes, so the mounted editor, its native
buffer, selection, and focus survive the toggle and Send's clear always reaches
the live input. A viewport crossing the compact breakpoint still remounts it:
the app shell swaps its gesture wrapper and the workspace screen
mounts tabs in different trees, so every screen below remounts. The draft owner
restores the text and the editing session restores the caret. Focus restoration
is limited to mouse-driven UIs, using the same fine-pointer policy as autofocus.
New workspace keys its sessions by draft in the app-level store for the same
reason. The centered form honors fullscreen by style alone: no centering, no
translation, setup fields hidden, slot filling the stationary viewport. The
global exit action (Escape, hardware back) is registered only for the active
composer: a retained tab keeps its fullscreen editor mounted while hidden, the
sheet suspends pane focus, and the composer gives up input from the moment the
user asks for the compact agent list or explorer, before the panel's motion
settles. Pane focus itself stays put under those panels: the agent panel reads
it as "the user is in this chat" for attention clearing, and opening the agent
list must not clear the attention it shows. On mouse-driven UIs, focus restoration
follows pane focus, not the active composer. Keying it on the active composer
made sidebar dismissal look like a hidden-tab blur and refocused on close.
Native and touch-web navigation must not replay old editor focus, including
when blur arrives after pane deactivation or the editor unmounts before blur.
Fullscreen toggles keep the editor mounted and need no focus restoration.
The band beside the inline editor where the fullscreen glyph sits is the input's
own right padding, so a tap anywhere in it focuses the editor whether or not the
glyph shows. On web the slot is a fixed box over the visible viewport, which is
also what lets a zoomed mobile page pan under it. Inside the slot, `ComposerFullscreenBody` reserves the keyboard
height as a bottom margin at move start and end (boundary-time, like the
capacity reservation) while `ComposerFullscreenFooter` rides the keyboard per
frame with `KeyboardTranslateView`, so Send lands on the keyboard without a gap
and without animating the editor's height. The screen that owns the chrome
unmounts it: the workspace screen reads `useComposerTabFullscreen` for the
active tab and New workspace reads the mounted composer's session. Hosts that
render the dock pass the same `ComposerEditingSession` to the `Composer` so the
dock, chrome, and editor agree on one fullscreen state. Escape (web overlay
registration, focus untouched) and the Android back button leave fullscreen.

Keep setup fields out of the composer's shrink chain. New workspace supplies its
setup fields as the first dock child so they move up under the header as the draft
grows. Putting the fields and composer in one bounded, shrinkable column made
Yoga split the shortage between them: rows vanished behind the composer while
the input lost lines at the same time. Keep that separation inside the dock,
shared by every phone host. The centered tablet form caps the complete block
for header clearance, but reserves the composer's own capped height before
shrinking the setup scroll view. The form must not take editing space from the
composer.

Move the stream and composer together through `ComposerDock`. Do not translate
them independently.

`KeyboardShiftProvider` owns the normalized shift used for settled insets and
portal geometry, plus the `isMoving` worklet value. It reconciles native
animation-end events because the controller can retain a nonzero value after
the keyboard closes.

Anchor a portal to content inside a `KeyboardTranslateView` with
`useKeyboardAnchor()`. Read it on the anchor's side of the Portal: the
translation scope is React context and does not cross it (Gotcha 7). It returns:

- `measureAtRest(element)`: the element's window rect with the keyboard
  translation left out, or null once the anchor unmounts. Lay the popover out
  from this rect. It assumes the translate view's parent does not move with the
  keyboard, which holds for the composer dock.
- `translation`: spread it onto a `KeyboardTranslateView` inside the Portal, so
  the popover moves with the anchor on the same driver, including centered
  clearance and disabled translation.
- `reservedLift`: the anchor's lift at keyboard boundaries. Bound the popover's
  height with it; never animate height per frame.

Do not measure an anchor with `measureInWindow` and correct it by the keyboard
shift. On iOS the translate view uses the native driver, and `measureInWindow`
includes its transform only when the view happened to re-render since the
keyboard moved. Both results were observed, so any correction double-lifts the
popover or leaves it behind the keyboard. `measureAtRest` measures through
Fabric's transform-free `measureLayout` instead. Re-measure when `isMoving`
settles; the composer's resting position changes as the draft grows.

The provider also reconciles iOS from the controller's native `onEnd` event.
The controller's stock iOS shared values update at move start and during an
interactive move, but not at the terminal event, so JS contention can otherwise
leave the last height/progress pair stuck in either the open or closed state.
Keep that terminal reconciliation on the UI thread; a later focus or blur must
not be required to repair the offset.

## Gotcha 4 — Host-relative positioning before platform offsets

The generic anchored-overlay rule is:

1. Measure the anchor with `measureInWindow`, or with `measureAtRest` when it
   moves with the keyboard (Gotcha 3).
2. Measure the Portal host with `measureFloatingPanelPortalHost(hostName)`.
3. Position with anchor coordinates relative to the host:

```ts
left = anchorRect.x - hostRect.x;
bottom = hostRect.height - (anchorRect.y - hostRect.y) + offset;
```

Do this before adding any platform offset. The app draws edge-to-edge on Android, so
`measureInWindow`, touch `pageY`, and a full-screen `Modal` all share one coordinate
space that starts at the screen top. Do not add `StatusBar.currentHeight` to an anchor:
React Native 0.86 stopped subtracting the status bar from window coordinates under
edge-to-edge, and the old compensation now lands every menu, tooltip, and context menu
one status bar below its trigger.

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

All sheets use the app-wide Gorhom modal provider through `IsolatedBottomSheetModal`, with no
exceptions: one stack means a sheet opened from any sheet lands on top of it and uncovers it on
close. This includes native centered dialogs: separate React Native Modals cannot present a
root-owned sibling dialog over an existing iOS presenter. `SheetHostScope` moves the portal host
and container measurement while forwarding the same modal queue. Compact
[workspace sheets](explorer-sidebar.md#sheets) use the app overlay host above both sidebars;
wide layouts keep local geometry. That export is
what `patches/@gorhom+bottom-sheet+*.patch` adds.

A sheet whose owner may veto the close (unsaved work) passes `enableDismissOnClose={false}`. Every
close path then parks the sheet at index -1 with its content mounted; the owner hears
`onChange(-1)`, runs its guard, and either snaps back to 0 or drops its state, which unmounts the
sheet and takes it off the stack. Calling `dismiss()` on such a sheet bypasses the guard and
unmounts it, so its backdrop and Back press call `close()`.

The wrapper must give Gorhom an object ref. Gorhom accepts a callback ref at the React boundary
but stores it in the modal queue and later reads `.current`; provider dismissal, replacement,
and restoration then silently do nothing. Callers may use callback refs on the wrapper, which
forwards commands to the current Gorhom handle.

Request a backdrop with `backdropOpacity`; do not install a caller-owned backdrop. On web,
Gorhom's default backdrop closes its own sheet, even when another modal is above it. Its animated
pointer-event changes can expose a lower backdrop during a transition. The shared web backdrop
keeps its press target until portal teardown and asks the provider to dismiss the top modal
(a guarded sheet closes itself instead, see above). Gorhom's presentation queue remains the
authority; backdrop mount order is irrelevant. Native retains Gorhom's gesture backdrop and the
same push/replace presentation semantics.

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

## Gotcha 8 — Read safe-area insets where the overlay draws

A compact sheet tab's body (`SheetBottomInset` in `adaptive-modal-sheet.tsx`) pads the bottom
inset and gives its content a bottom inset of 0, so the composer dock sits the same in a sheet as
in a tab. An overlay opened from that content and calling `useSafeAreaInsets()` at its call site
gets that 0 and draws over the navigation bar.

- A Gorhom sheet reads the inset inside its children, which render in the app's sheet host. See
  `CompactSheetBody`, `MenuSheetScrollView` and `ComboboxSheetFrame`.
- An RN `Modal` passes the call site's context straight through, so put a `SafeAreaProvider`
  inside it and read the inset below that. The modal is its own window, and the provider measures
  it. See `attachment-lightbox.tsx`.

## Recipe for a new anchored panel

Before you write a new one, ask:

1. **Can the underlying input lose its keyboard?** If yes, use Modal (simpler).
   If no, use Portal.
2. **Does the panel need to dismiss on screen change?** Almost always yes —
   gate `visible` on an upstream focus prop (`isPaneFocused` or similar).
3. **Is the panel rendered in a Portal host?** Measure the host too. Never use
   raw window coordinates as local Portal coordinates.
4. **Does the panel sit above something that moves with the keyboard?** If
   yes, anchor it with `useKeyboardAnchor()` and wrap it in a
   `KeyboardTranslateView` with the anchor's translation (Gotcha 3).
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
