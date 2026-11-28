# @react-native-gpui/worklets

Adapter for [`react-native-worklets`](https://github.com/software-mansion/react-native-reanimated/tree/main/packages/react-native-worklets) (MIT): runs worklets on desktop, driven by the renderer's frame clock.

Part of [react-native-gpui](https://github.com/streetwriters/react-native-gpui), React Native for macOS, Windows and Linux.

## Install

Install it next to `react-native-worklets`:

```sh
npm install react-native-worklets@0.13.x @react-native-gpui/worklets
```

Install the regular npm release of `react-native-worklets`. Its C++ needs small fixes to build with MSVC and on Linux; this package applies them to a copy in the desktop build directory and never changes `node_modules`.

Keep using `react-native-worklets` as you do on iOS and Android; its JavaScript API is unchanged. Autolinking builds the desktop side when the app is built.

## Documentation

[Supported libraries](https://streetwriters.github.io/react-native-gpui/docs/supported-libraries)

## License

MIT. See [LICENSE](LICENSE).
