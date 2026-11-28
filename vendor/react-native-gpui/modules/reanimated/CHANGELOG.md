# Changelog

All notable changes to `@react-native-gpui/reanimated` are listed here. Each version's section becomes the notes of its GitHub release.

## Unreleased

- Builds with MSVC 14.51 (Visual Studio 18): the members of the resolvable transform interpolator are defined in the class body, since that compiler cannot match their out-of-line definitions.

## 4.7.0-alpha.1 - 2026-11-12

- CSS transitions and animations now run: the registries' updates are applied after every frame, as the display link does on iOS, where before nothing applied them and a transition or keyframe animation never changed what was painted. Needs a prebuilt runtime built with the change.

## 4.7.0-alpha.0 - 2026-11-01

- First release, for `react-native-reanimated` 4.7.x with Worklets 0.13.x.
- Animations, layout animations and CSS animations on desktop.
- Works with the npm release of `react-native-reanimated`: the C++ fixes it needs for MSVC and Linux are applied to a copy in the build directory. UI props update synchronously on Linux, as on iOS.
