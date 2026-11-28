# Changelog

All notable changes to `@react-native-gpui/svg` are listed here. Each version's section becomes the notes of its GitHub release.

## 15.15.0-alpha.1 - 2026-11-12

- A drawing is looked up by a structural hash of its props, children, frame size and scale, so a render that finds it builds no document string. Before, every render built and escaped the whole SVG document just to hash it, even when the raster was cached.
- The rasters are kept in one cache shared by every node, bounded by bytes (64 MB; `RN_GPUI_SVG_CACHE_MB` sets another) and dropping the image used longest ago first. It held weak references before, so an icon that left the screen was rasterised again when it came back, and the same icon in two places was drawn twice.
- A drawing that is not cached is rasterised on a background thread when it is large (over about 48 CSS pixels square at a scale of 2) or has a filter, or when its node already shows an image (a theme switch). The node keeps showing its previous image until the new one is ready, then is built again; a node with nothing to show yet draws nothing until then. A small icon whose node has no image is still drawn at once, so a row that scrolls in has its icon on the first frame. Several nodes asking for the same drawing share one rasterisation.
- The four coverage samples of a drawing are rasterised side by side (a small one, under 128 by 128 pixels, one after the other, because starting a thread costs more than a sample) and combined in a fixed order, so the pixels are the same as when they were drawn one after the other (a test compares them in both ways). A 230 point illustration with drop shadows takes 30 ms to rasterise instead of 120, and now off the main thread.
- `RN_GPUI_SVG_TRACE=1` logs each rasterisation with the time of every sample, and `RN_GPUI_SVG_SYNC=1` draws everything on the main thread, for measuring.
- An SVG is drawn with the same antialiasing as Chrome: once per coverage sample at the window's scale, without antialiasing, with the four sample positions Chrome uses, and averaged. An icon's edge now takes the same five coverage steps (0, 1/4, 1/2, 3/4, 1) at the same pixels, so the Material star at 16 points differs from Chrome in 5 of 1024 pixels instead of 112, and over 80 icons in 124,480 pixels in 1,288 instead of 7,250. Needs `image` and `smallvec` in the crate.
- An SVG is placed at a whole CSS pixel, as Chrome places an inline SVG: a 15 point icon centred in a 20 point button, which lays out at 2.5, is drawn at 3 instead of half a point to the left. That half point was the bulk of the edge pixels that differed from the web app (97 of 1,600 in a toolbar arrow, 2 now).
- An element's `transform` is applied: react-native-svg sends it as a six number `matrix`, which was only read when it had sixteen, so every rotated or scaled shape was drawn untransformed.
- Filters are drawn: `filter` on a shape or group, `<filter>` and the `feBlend`, `feColorMatrix`, `feComposite`, `feFlood`, `feGaussianBlur`, `feMerge` and `feOffset` primitives reach the renderer, with `sRGB` colour interpolation. An illustration with rotated cards and drop shadows at 230 points differs from Chrome in 249 of 211,600 pixels by more than 8 levels instead of 14,817.
- Asks core for each node's subtree, which core now hands a component renderer only when it reads it.

## 15.15.0-alpha.0 - 2026-11-01

- First release, for `react-native-svg` 15.15.x.
- Renders SVG elements with the desktop renderer.
