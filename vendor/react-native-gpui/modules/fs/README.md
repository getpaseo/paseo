# @react-native-gpui/fs

Our own module: a file system API for desktop apps, shaped like Node's `node:fs`, with file dialogs and the operating system's well-known folders.

Part of [react-native-gpui](https://github.com/streetwriters/react-native-gpui), React Native for macOS, Windows and Linux.

## Install

```sh
npm install @react-native-gpui/fs
```

## Usage

```js
import fs, { dialog, paths } from '@react-native-gpui/fs';

const text = fs.readFileSync(`${paths.documents}/notes.txt`, 'utf8');
await fs.promises.writeFile(
  `${paths.appData}/state.json`,
  JSON.stringify(state),
);

const [file] = await dialog.open({
  filters: [{ name: 'Text', extensions: ['txt'] }],
});
```

The default export has the synchronous, callback and promise forms of the common `node:fs` calls, with Node's encodings, `Stats`, `Dirent` and error codes. The module runs on its own thread, so slow files never block JavaScript or the interface.

## Separate app data

Set `RN_GPUI_APP_DATA_DIR` to a non-empty folder to run several copies of an app side by side with separate data, without overriding `HOME`. `paths.appData` becomes `$RN_GPUI_APP_DATA_DIR/<id>`, `paths.appCache` `$RN_GPUI_APP_DATA_DIR/cache/<id>` and `paths.appLogs` `$RN_GPUI_APP_DATA_DIR/logs/<id>`; the other paths are unchanged.

## Documentation

[File system](docs/file-system.md)

## License

MIT. See [LICENSE](LICENSE).
