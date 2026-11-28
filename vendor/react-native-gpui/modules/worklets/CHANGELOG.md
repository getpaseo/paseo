# Changelog

All notable changes to `@react-native-gpui/worklets` are listed here. Each version's section becomes the notes of its GitHub release.

## 0.13.0-alpha.1 - 2026-11-12

- Added a hook that runs after each frame's animation callbacks, which Reanimated uses to apply its pending updates.

## 0.13.0-alpha.0 - 2026-11-01

- First release, for `react-native-worklets` 0.13.x.
- Runs worklets on desktop, driven by the renderer's frame clock.
- Works with the npm release of `react-native-worklets`: the C++ fixes it needs for MSVC and Linux are applied to a copy in the build directory.
