# @react-native-gpui/core

React Native for macOS, Windows and Linux. One GPU-accelerated renderer, [GPUI](https://github.com/zed-industries/zed/tree/main/crates/gpui), draws your app on every desktop, through React Native's Fabric renderer and Yoga layout.

Part of [react-native-gpui](https://github.com/streetwriters/react-native-gpui), React Native for macOS, Windows and Linux.

## Get started

Create an app:

```sh
npx @react-native-gpui/cli init MyApp
cd MyApp
npx react-native run-desktop
```

Or add a desktop target to an existing React Native app:

```sh
npx react-native init-desktop
```

The first build downloads a prebuilt copy of React Native's C++ runtime, so only your app is compiled.

## What you get

- The core components and APIs, rendered on the GPU.
- Desktop APIs: windows, application and context menus, a tray icon, keyboard shortcuts, deep links and single-instance apps.
- An accessibility tree for VoiceOver, Narrator and Orca.
- Native modules in Rust or C++, native views, and Node-API addons.
- Packaging to `.app`/`.dmg`, an NSIS installer, and `.deb`/`.AppImage`.

## Documentation

[Getting started](https://streetwriters.github.io/react-native-gpui/docs/getting-started)

## License

MIT. See [LICENSE](LICENSE).
