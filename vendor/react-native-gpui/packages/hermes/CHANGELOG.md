# Changelog

All notable changes to `@react-native-gpui/hermes` are listed here. Each version's section becomes the notes of its GitHub release.

## 0.87.0-alpha.1 - 2026-11-12

- Release builds link a Hermes VM built without the debugger, and debug builds the one with it. With the debugger compiled in, a release app kept debugger state it never used, including the compiler state of every `eval`, which held about 22 MB in an app whose worklets are made with `eval`. Each platform's binaries hold both VMs, the release one under `release/`. Engine build 0.1.3.

## 0.87.0-alpha.0 - 2026-11-01

- First release.
- The Hermes engine for react-native-gpui: public headers and prebuilt VM and compiler binaries for macOS, Windows and Linux, on x64 and arm64.
- Engine build 0.1.2, with `Intl` on the system ICU.
