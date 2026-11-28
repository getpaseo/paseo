# @react-native-gpui/cli

Command-line tools for React Native desktop apps: create, run, test and package them.

Part of [react-native-gpui](https://github.com/streetwriters/react-native-gpui), React Native for macOS, Windows and Linux.

## Commands

| Command                                  | Description                                                   |
| ---------------------------------------- | ------------------------------------------------------------- |
| `npx @react-native-gpui/cli init MyApp`  | Creates an app with a `desktop/` target.                      |
| `npx react-native init-desktop`          | Adds a `desktop/` target to an existing app.                  |
| `npx react-native doctor-desktop`        | Checks the toolchain for this operating system.               |
| `npx react-native run-desktop`           | Builds and runs the app. Add `--release` for a release build. |
| `npx react-native package-desktop`       | Builds installers: `.app`/`.dmg`, NSIS, `.deb`/`.AppImage`.   |
| `npx react-native create-library <Name>` | Creates a native module library in Rust or C++.               |

## Documentation

[CLI](https://streetwriters.github.io/react-native-gpui/docs/cli)

## License

MIT. See [LICENSE](LICENSE).
