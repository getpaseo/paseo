# @react-native-gpui/svg

Adapter for [`react-native-svg`](https://github.com/software-mansion/react-native-svg) (MIT): draws SVG elements with the desktop renderer.

Part of [react-native-gpui](https://github.com/streetwriters/react-native-gpui), React Native for macOS, Windows and Linux.

## Install

Install it next to `react-native-svg`:

```sh
npm install react-native-svg@15.15.x @react-native-gpui/svg
```

Keep using `react-native-svg` as you do on iOS and Android; its JavaScript API is unchanged. Autolinking builds the desktop side when the app is built.

## What is drawn

Shapes, paths, text, gradients, masks, clip paths, symbols, patterns and markers, with the transform of each element (react-native-svg sends it as a six number matrix). Filters are drawn too: `filter` on a shape or group and the `feBlend`, `feColorMatrix`, `feComposite`, `feFlood`, `feGaussianBlur`, `feMerge` and `feOffset` primitives, always with sRGB colour interpolation. An icon is drawn with the same antialiasing as Chrome and placed at a whole CSS pixel, as Chrome places an inline SVG.

Limits: `overflow="visible"` is not honoured (the drawing is clipped to the SVG's frame), the other filter primitives such as `feDropShadow` and `feMorphology` are not passed to the renderer, and a blurred shadow comes out about one level lighter than Chrome's for each shadow that overlaps another.

## Cost

A drawing is cached by a hash of what it is made of, so drawing it again costs a hash and a lookup. The cache is shared by every node and holds up to 64 MB of images (`RN_GPUI_SVG_CACHE_MB` changes that). A drawing that is not cached yet is rasterised on a background thread when it is large or filtered, and the node shows its previous image, if it has one, until the new one is ready; a small icon with nothing yet to show is drawn at once. `RN_GPUI_SVG_TRACE=1` logs each rasterisation and `RN_GPUI_SVG_SYNC=1` draws on the main thread, to measure.

## Documentation

[Supported libraries](https://streetwriters.github.io/react-native-gpui/docs/supported-libraries)

## License

MIT. See [LICENSE](LICENSE).
