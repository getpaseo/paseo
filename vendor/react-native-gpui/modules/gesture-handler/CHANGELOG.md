# Changelog

All notable changes to `@react-native-gpui/gesture-handler` are listed here. Each version's section becomes the notes of its GitHub release.

## 3.3.0-alpha.1 - 2026-11-12

- A gesture whose callbacks run on the JS thread (`runOnJS(true)`, or a handler from the old API) receives its events. They were sent to its view, where only worklet callbacks listen, so a sheet dragged by such a gesture did not move.

## 3.3.0-alpha.0 - 2026-11-01

- First release, for `react-native-gesture-handler` 3.3.x with Reanimated 4.7.x and Worklets 0.13.x.
- Gesture recognition for mouse, trackpad and touch input on desktop.
