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

- **`Modal`** (combobox, tooltip on native) — opens a new Android window, so
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

The fix for transforms is Gotcha 3.

## Gotcha 3 — Reanimated transforms vs `measureInWindow`

`measureInWindow` returns the view's _current_ screen position. In theory that
includes Reanimated-applied transforms (Reanimated updates native view
properties, and Android's `getLocationInWindow` reads transformed coords). In
practice it's racy — the measurement may snapshot mid-animation, and on Android
with Reanimated worklets the result is not always stable.

If the panel cannot stay inside the transformed ancestor, do not try to track
the keyboard by re-measuring on every frame. Instead,
**slave the popover's transform to the same `KeyboardShiftProvider` SharedValue
the composer uses**:

1. Snapshot `openShift = shift.value` at the moment you measure the anchor.
2. Apply `useAnimatedStyle(() => ({ transform: [{ translateY: openShift.value - shift.value }] }))`
   to the popover wrapper.

When `shift` equals `openShift`, the translate is 0 and the popover sits at
the measured position. When the keyboard moves afterward, the delta translates
the popover by exactly the amount the composer translates. They move in
lockstep, no re-measurement needed. Do not call
`useReanimatedKeyboardAnimation()` directly for app UI offset policy; Android
can briefly report a stale nonzero height with closed progress, and the shared
provider is where that is normalized.

Re-measure on `Keyboard.addListener('keyboardDidShow'|'keyboardDidHide')` only
to refresh the snapshot if the keyboard was mid-transition when the popover
opened.

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
