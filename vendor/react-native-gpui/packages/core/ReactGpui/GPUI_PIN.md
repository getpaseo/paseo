# GPUI pin

We build on the `streetwriters/gpui-fast` fork: GPUI extracted from the Zed
monorepo, with a retained-mode layout engine (unchanged views are replayed,
layout nodes reused). It keeps upstream GPUI's API; fork code lives in `fast/`
dirs with small hooks. Experimental, git-only (no crates.io releases or tags),
so we pin by commit SHA and bump on purpose.

## Pinned

- Repository: https://github.com/streetwriters/gpui-fast
- Branch: `rn-gpui-linux` (tracks upstream `main` with Linux fixes on top so each one can become an
  upstream pull request, plus fixes for content drawn under a transform and allocation cuts)
- Commit: `1ad3cc3` (2026-11-21: `de5ebfa` plus browser-like nested and axis scrolling and faster CPU screenshots, with `Window::render_region_to_image` (test-support) drawing one device-pixel region of a frame, which the test driver's element screenshots use. `de5ebfa` (2026-11-19: `8ddec44` plus a CPU renderer (tiny-skia) for headless tests, which `gpui_platform::test_rendering` falls back to where no GPU renderer can be made; the test driver's headless runs draw with it. `8ddec44` (2026-11-19) is `57efe10` plus a held window that can draw outside the frame request without presenting, which native roots use to settle a new page's size within the tick. `57efe10` is `9125f46` plus headless test screenshots. `9125f46` is `70f968b` with the commit after it reverted, so the same tree. `70f968b` (2026-11-18): `bdecaba` plus testing windows by role and visible text over the accessibility tree. `bdecaba` is `bcfa3e3` plus a window that can hold back presenting while its content settles, which native roots use so a new page is shown at its final layout. `bcfa3e3` is `3f7a51a` plus a button drawn again from the last frame keeping its
  own accessibility label instead of the text inside it. `3f7a51a` is `3efc3d0` plus a change of input modality (mouse, keyboard or
  touch) building only the views that read it, and accessibility nodes replayed for a retained
  stretch pushed with the role they had, so a view built again inside a scroll view drawn from
  the last frame is still known to be inside it. `3efc3d0` is `93193d4` plus nested views sharing their retained layouts
  instead of copying them, so a view's cost does not grow with its depth, and a retained record's
  frame indices kept in 32 bits. `93193d4` is `74dcd1f` plus memory cuts: the element arena frees the chunks the
  last two frames did not use and keeps at most eight; global element ids are interned as a parent
  link and the last id instead of a copy of the whole path; retained records share what they
  inherit, their text styles and their rebuild text style stack, and keep a cached style boxed; a
  drawn frame's lists are fitted to it; a window idle for a second frees its spare frame's lists
  and the arena's chunks; the windows an entity invalidates are a short list rather than a map.
  `74dcd1f` is `3bd25f1` plus a change of focus building only the views that read it; `3bd25f1` is
  `af2bd3a` plus text in an effect group drawn without subpixel rendering and a view that paints an
  effect group rebuilt rather than spliced. `af2bd3a` (2026-11-16) is `3ad00a0` plus a destination-in blend mode and effect groups that
  cover their bounds, used to mask children by another element's alpha, and scroll containers exposed
  as scroll areas to accessibility. `3ad00a0` (2026-11-11) is `355baeb` plus macOS windows keeping the frame they were given
  while a test driver runs the app in the background, so a test window larger than a small CI display
  is not shrunk to it. `355baeb` is Abdullah Atta's accessibility commits on `rn-gpui-linux` (unlabelled
  buttons, links and tabs named by their painted text, clickable elements without a role as buttons,
  hover and tooltips through the accessibility API) and macOS test windows that open behind the user's
  and never activate, plus Windows restoring a zoomed window when it is zoomed again. Before them,
  `11fd570`: `b015e2b` plus Windows honouring the test scale factor
  (`RN_GPUI_TEST_SCALE_FACTOR`) and letting a window outgrow the display for it. `b015e2b` is `9087620` plus windows reporting themselves active on Linux while the
  test driver runs the app, as macOS already did, so focus and blur reach elements of a test window
  that is never mapped or focused. `9087620` is `d5041b0` plus two commits for react-native-gpui. `d5041b0` is Longbridge's
  gpui-fast `main` merged into `rn-gpui-linux`, with upstream's public API kept for `ContentMask`,
  `Hitbox` and `paint_svg`, GPUI Kit 0.9.1 and gpui-pre 0.3.12 tracked, and the hover freeze (the end
  of a freeze draws the window again without refreshing it). The two commits: a key the focused input
  takes as text is not offered to the key listeners of its ancestors (`fast::text_keys`, with the
  platform insertion untouched), and `test-support` methods that drive the focused input handler as an
  input method would (`Window::simulate_marked_text` and `simulate_committed_text`). It still has
  `5392403`'s test hooks: a window scale factor a test run asks for (`RN_GPUI_TEST_SCALE_FACTOR`) and
  windows reporting themselves active while the test driver runs the app in the background))
- Toolchain: Rust 1.98 or newer (gpui-fast pins 1.98.1 and uses `Option::map_or_default`)
- Every manifest that names gpui-fast uses this commit: `packages/core/ReactGpui`,
  `packages/rn-gpui-tester/desktop` and
  `packages/rn-gpui-tester/host-components-module/desktop`. The modules in
  react-native-gpui-modules follow the same commit; see AGENTS.md
- Pinned in: `Cargo.toml` `[workspace.dependencies] gpui.rev`

## Startup deferrals

- `c380367` `gpui_macos: defer work the first frame does not read`
  - `MacKeyboardLayout::new` runs on first key use rather than at platform
    creation. It cost about 30 ms — `platform created` fell from 43 ms to 12 ms
    once it was lazy, and nothing in the first frame reads a keyboard layout.
  - `NSWindow.setAllowsAutomaticWindowTabbing(false)` is set once at platform
    start instead of per window, so `NSWindow.tabGroup` is nil from the outset
    and `tab_bar_visible` answers without asking AppKit. A window that asks for
    a tabbing identifier re-enables it in its own initialiser.

## Carried patches on top of upstream

- `7338a98` `gpui: map X11 windows only when shown` (honour `show: false`)
- `2895a8f` `gpui_linux: apply resizes to unmapped X11 windows`
- `09a45a7` `gpui_linux: log a missing XInput pointer as a warning`
- `8034d63` `gpui_linux: implement render_to_image for X11 and Wayland`
- `f8edd01` `gpui: expose accessibility identifiers and states in the debug tree`
- `f1abf86` `gpui_linux: track the X11 map state from map and unmap events`
- `1db8564` `gpui_windows: deliver hover callbacks outside the window procedure`
  — the commit message says "hover and resize", but only hover is deferred in it:
  `WM_SIZE` and `WM_MOVE` still invoked their callbacks inline, so the earlier
  pin compensated in shared `window.rs` instead. `172d79f` finishes the job in
  the backend and that compensation is gone.
- `8e846d2` `gpui_windows: skip windows that are already gone`
- `ebf3ced` `gpui: ignore platform callbacks for a window that has been removed`
  — amended in effect by `394557f`: that commit made five callbacks discard their
  `update` result, which also silenced a failed `App` borrow. The removed-window
  case is now a typed `WindowRemoved` error that only that case ignores; every
  other failure is logged again.
- `172d79f` `gpui_windows: defer resize and move out of the window procedure`
- `394557f` `gpui: log a failed borrow in the platform callbacks again`
- `ffc9655` `gpui: defer the move callback so a synchronous move cannot re-enter
App` — a move performed from inside an `App` update (a JS `set_position`,
  which AppKit implements with `setFrameTopLeftPoint:`) is notified before that
  call returns, so `on_moved` ran `handle.update` while the caller still held
  the `App` and logged `ERROR gpui::window] RefCell already borrowed`. It now
  defers through the foreground executor, as `on_appearance_changed` already
  does. macOS-only in practice, but the callback is shared, so Windows and Linux
  re-run their window tests against this pin.

### Carried patch: `on_hit_test_window_control` order

- `a72b326` `gpui: answer the control hit-test for the frontmost element`

  The callback answered with the first entry of `window_control_hitboxes` under
  the pointer. That list is in paint order, and an element inserts its own
  control hitbox before its children paint, so an ancestor always won — a drag
  region covering a title bar matched before every button inside it. On Windows
  the whole bar therefore answered `HTCAPTION`, and a press on a caption button
  or any interactive child became a non-client message: the window started
  moving instead of the button receiving a mouse-down.

  It now walks the real hit test front to back, the order pointer dispatch uses.
  A frontmost hitbox that is not a control area returns `None` rather than
  continuing the walk, because every hitbox in that list belongs to an element
  that takes the mouse, focus, scroll or a cursor, so it owns the press.

  It was fixed in the fork rather than worked around in `rn-gpui` because the
  alternative — not marking the drag region at all on Windows — would lose
  `HTCAPTION` and with it snap layouts, double-click maximise and the system
  move loop (`start_window_move()` is a no-op in `gpui_windows`).

### Carried patch: every window callback ignores a removed window

- `40700ec` `gpui: ignore a window removed before a platform callback arrives`

  `ebf3ced` routed five platform callbacks through `ignore_if_window_removed`;
  the rest (`on_resize`, `on_moved`, `on_visual_viewport_changed`,
  `on_insets_changed`, `on_appearance_changed`, `on_button_layout_changed`, the
  frame request and the input callbacks) still ended in `.log_err()`. A macOS
  popup that was dismissed could receive a resize or move after it was removed,
  and the e2e `opening and closing a popup repeatedly logs no errors` caught
  `ERROR gpui::window] window not found` on CI. Every
  `handle.update(...).log_err()` in `Window::new` now goes through the same
  helper, so only the removed-window case is ignored and any other failure is
  still logged.

### Carried patch: no error for a cursor message to a closed window

- `7bf381d` `gpui_windows: do not log a cursor message posted to a window that just closed`

  `set_cursor_style` posts a message to every tracked window, and a window that
  has just been destroyed is still in the list for a moment. `PostMessageW` then
  fails with `ERROR_INVALID_WINDOW_HANDLE`, which was logged at ERROR and failed
  the e2e `a second window opens with its own surface and closes again` on
  Windows CI. That one code is now ignored; every other failure is still logged.

### Carried patch: hidden overflow clipped to rounded corners

- `8da7d89` `gpui: clip hidden overflow to rounded corners`

  A content mask was a rectangle, so `overflow: hidden` with a border radius
  clipped children square, where iOS and Android clip them to the rounded
  corners. The mask now also carries one rounded rectangle, which every
  renderer (Metal, Direct3D, wgpu) applies per fragment to quads, shadows,
  underlines, glyphs, images and paths; scroll layers keep it when they are
  composited. Elements opt in with `overflow_clips_corners()`, which `rn-gpui`
  sets wherever React Native clips (`overflow: hidden` and scroll views); other
  GPUI code keeps a rectangular clip.

  The patch adds API: `ContentMask` has two more fields, so a struct literal
  must become `ContentMask::new(bounds)`, and `overflow_clips_corners` is new.
  Surfaces and external textures stay rectangular, and nested rounded clips
  keep only the innermost one.

> **Cargo does not notice edits to a git checkout**, which matters only if you
> edit one by hand without bumping the pin. It fingerprints the checkout by
> revision, so after editing `window.rs` it still reports `Fresh gpui` and links
> the old rlib — the change looks like it does nothing. Verified by injecting a
> `compile_error!` and watching the build succeed anyway. If you ever do this,
> `rm -rf target/debug/.fingerprint/gpui-*` and look for a
> `Compiling gpui v0.2.2 (…?rev=…)` line as proof it took.

`on_hit_test_window_control` used to answer with the first entry of
`rendered_frame.window_control_hitboxes` whose hitbox was under the pointer.
That list is in _paint_ order, and an ancestor paints its own control hitbox
before its children paint theirs, so a drag region covering a title bar always
matched before a button inside it. On Windows the whole bar therefore answered
`HTCAPTION`: a press on a button in the bar moved the window instead of pressing
the button.

The callback now walks `rendered_frame.hit_test(mouse_position).ids` — front to
back, the same order pointer dispatch uses — and returns the first hitbox's
control area, or `None` if the frontmost hitbox belongs to an element that is not
a control area. Only hitboxes whose elements listen for the mouse, take focus,
scroll or set a cursor are inserted at all, so "frontmost is not a control area"
means "an interactive element owns this press", which is exactly the case where
the window must not be moved. The hit test is computed inside the callback rather
than read from `mouse_hit_test`, because that field is only refreshed when a mouse
event is dispatched and the first `WM_NCHITTEST` arrives before any pointer event.

To reproduce it on a fresh checkout, apply this to
`crates/gpui/src/window.rs` and remember that **cargo does not notice edits to a
git checkout on its own** — `cargo clean -p gpui` (or a full rebuild) is needed
or the old rlib is reused silently.

## Upstream (from the repo's `UPSTREAM` file at that commit)

- Zed repository: https://github.com/zed-industries/zed
- Zed commit: `a1b71072e5b43faef437b471e988fbb5f972c99c`
- gpui-fast import commit holding that import unchanged:
  `8848cdcf22eb7479a07a17d8ca627dc8144e4f38` (branch `sync/zed-a1b7107`,
  merged as gpui-fast#38)

`git show <import_commit>:<path>` in gpui-fast gives upstream's version of a
tracked path without a Zed checkout.

## Policy

- `rn-gpui` uses only upstream GPUI APIs. gpui-fast promises that upstream code
  compiles against its fork unchanged.
- Until gpui-fast lands window composition (zed#62379), carry that patch on our
  own branch of gpui-fast if we need it (design doc §5).
- Bump the SHA deliberately; record the new SHA + UPSTREAM Zed commit here.

## Known limitation: retained views under accessibility

The retained-view fast path is disabled while a screen reader is active:

- `crates/gpui/src/fast/retained.rs:544` (`self.a11y.is_active()`)
- `crates/gpui/src/fast/splice.rs:297` (`self.a11y.is_active()`)
- `crates/gpui/src/fast/layers/mod.rs:121` (`!window.a11y.is_active()`)

With it disabled, a visible window rebuilds its element tree on every refresh,
so the `retained static siblings do not render with changing siblings` e2e check
expects 5 recorded paints but sees every subsequent paint as well. Hidden
(offscreen) windows do not refresh from events, which is why the offscreen e2e
runs pass with the accessibility bus on.

Because of that, the Linux e2e runner leaves the AT-SPI bus off for **headed**
runs (`packages/rn-gpui-tester/scripts/run-e2e.mjs`), so the native
accessibility assertions skip there. Offscreen runs still enable the bus.
Setting `RN_GPUI_TEST_NATIVE_A11Y=1` forces the bus on even when headed.

Windows is not affected, and needs no equivalent rule. Activation there is
per process: `gpui_windows` only starts publishing when a client asks the window
for its accessibility provider (`WM_GETOBJECT`), and the test driver asks on
behalf of the assertions, so only the process running an accessibility test has
`a11y.is_active()` set. A headed run was measured with accessibility active and
the `retained static siblings` check passed; each test launches its own app
process, so the activation cannot leak between them.

Fixing this properly means replaying accessibility subtree updates for retained
views; that is out of scope for now.

## Transforms

- `590f2bb`, `a678e91`, `8dab27d`, `81357fc`, `3a4e87e`: a per-frame table of 2D affine matrices and
  an index on every primitive (`Quad`'s packs it above its border style).
  `Window::with_transformation` and `with_transformation_about` draw and
  hit-test a subtree under a matrix; hit boxes keep theirs. The Metal shaders
  evaluate corners, borders, masks and shadows in the primitive's own space.
  The wgpu shaders read the table from a storage buffer at group 0 binding 2
  (16384 entries; the WebGL transport has none and draws untransformed). The
  DirectX shaders read it from a structured buffer at `t2`.
- `d58e7e2`..`464a119`: glyph and SVG sprites no longer carry an inline matrix; an `Svg`
  with a `Transformation` draws under `Window::with_transformation` (so its clip is in the
  svg's own space and it bypasses tile layers). Mono and subpixel sprites are 24 bytes
  smaller, and the WebGL record stride for them is 30 words. A hit box keeps an `Rc` of its
  matrix (none for the identity), so layers and retained frames can carry it.
  Replay skips the table for identity primitives.
- `934adc1`: `Window::composed_scene_layers` reports how the last frame is split across
  GPUI composition surfaces, so a test can see which surface a view painted onto.
- `48ef745`: effect groups (`Window::with_effect_group`): a subtree painted into a texture of its own and
  composited with group opacity, a blur or drop shadow of its picture, and a CSS blend mode against a copy of what is beneath it, on Metal, wgpu and Direct3D 11. `Scene::finish` moves each group's primitives
  into a scene of its own, in the texture's space. A group's texture is its bounds rounded out to device pixels
  and clipped to the window (wgpu and Direct3D round the texture up to 64 px so frames reuse it). A scroll view whose content holds a group is not cached as a layer (the node counts it);
  a group inside layer content, were there one, would fade each shape on its own.
- `549d4cd`: a native surface on Windows is hidden by an empty clip; a visual from a plain
  DirectComposition device has no `IDCompositionVisual3` opacity.
  Against `8da7d89` on `randomized_element_tree` (18 cases): foreground instructions +0.4%,
  wall time median about +1%, the smallest frames (110-210 us) still 5-10% slower.

## Rendering

- `df99de6`: the Metal layer is tagged sRGB, so a wide-gamut display shows a React
  Native colour the way AppKit shows the same sRGB value.
- `956427e`: blurred shadows are dithered on every backend (interleaved gradient noise,
  scaled by the alpha so a zero stays zero), and the wgpu linear gradient is dithered like
  the Metal and DirectX ones. The noise is keyed to the primitive's own origin, so a tile
  rasterised at another offset gets the same pixels.
- `bdc7e62`..`e2a4638`: colour filters. `Window::with_color_filter` composes a 4x5 colour matrix into
  the same per-frame table as transforms (the wgpu storage buffer holds both; DirectX reads
  the matrices at `t3`; Metal binds them at fragment buffer 9). Each primitive is filtered on its
  own, so overlapping content is not filtered as a group. Paths and surfaces are not filtered.

## API changes at `93193d4`

- `GlobalElementId` no longer dereferences to `[ElementId]`: it is the last id and a link to the
  id of the path above it. `Display` and `Debug` still print the whole path.

## API changes at `807f4e5`

- `Keystroke::parse` takes a `&'static str` with explicit modifiers; dynamic text, and the
  `secondary-` alias, goes through `Keystroke::parse_with_os` and `KeyBinding::load(.., cx)`.
  `Keystroke` has no `Display`; use `unparse(os)`. `Modifiers::secondary` takes `&App`.
- `PlatformInput::ScrollWheel` and `ScrollWheelEvent` are `PlatformInput::Scroll` and
  `ScrollEvent` (with a `source`); `on_scroll_wheel` is `on_scroll`.
- Effect groups use atlas texture ids from `0xE000_0000` and dynamic textures from `0xE800_0000`.
- Dynamic textures carry their version in `AtlasTile::padding`.
