# @react-native-gpui/reanimated

Adapter for [`react-native-reanimated`](https://github.com/software-mansion/react-native-reanimated) (MIT): runs animations, layout animations and CSS animations on the desktop renderer.

Part of [react-native-gpui](https://github.com/streetwriters/react-native-gpui), React Native for macOS, Windows and Linux.

## Install

Install it next to `react-native-reanimated`:

```sh
npm install react-native-reanimated@4.7.x @react-native-gpui/reanimated
```

Reanimated needs Worklets, so install `react-native-worklets@0.13.x` and [`@react-native-gpui/worklets`](https://www.npmjs.com/package/@react-native-gpui/worklets) too.

Install the regular npm release of `react-native-reanimated`. Its C++ needs small fixes to build with MSVC and on Linux; this package applies them to a copy in the desktop build directory and never changes `node_modules`.

Keep using `react-native-reanimated` as you do on iOS and Android; its JavaScript API is unchanged. Autolinking builds the desktop side when the app is built.

## Documentation

[Supported libraries](https://streetwriters.github.io/react-native-gpui/docs/supported-libraries)

## License

MIT. See [LICENSE](LICENSE).
