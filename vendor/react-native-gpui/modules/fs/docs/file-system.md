---
id: desktop-file-system
title: File system
---

`@react-native-gpui/fs` is a file system API for desktop apps. It follows `node:fs`, so code and habits from Node carry over, and adds file dialogs and the well-known folders of the operating system.

```shell
npm install @react-native-gpui/fs
```

```js
import fs, { dialog, paths } from '@react-native-gpui/fs';
```

The module runs on its own thread, so a slow file never blocks JavaScript or the interface.

## Reading and writing

The default export is the `node:fs` object, with synchronous, callback and promise forms:

```js
const text = fs.readFileSync(`${paths.documents}/notes.txt`, 'utf8');

await fs.promises.writeFile(
  `${paths.appData}/state.json`,
  JSON.stringify(state),
);

const entries = await fs.promises.readdir(paths.downloads, {
  withFileTypes: true,
});
```

The common operations are available: `readFile`, `writeFile`, `appendFile`, `stat`, `lstat`, `readdir`, `mkdir`, `rm`, `rename`, `copyFile`, `cp`, `access`, `realpath`, `readlink`, `symlink`, `truncate`, `utimes`, `chmod`, `mkdtemp`, `open` with `FileHandle`, and `existsSync`. Encodings, `Stats`, `Dirent`, flags and `constants` behave as they do in Node. Errors carry Node's error codes, such as `ENOENT`.

Text is read and written as UTF-8 directly in native code. Other encodings and binary data go through `ArrayBuffer`.

## Well-known folders

`paths` holds the folders the operating system defines. They are created the first time you read them:

| Name        | Folder                                     |
| ----------- | ------------------------------------------ |
| `home`      | The user's home folder.                    |
| `documents` | Documents.                                 |
| `downloads` | Downloads.                                 |
| `desktop`   | The desktop.                               |
| `temp`      | The temporary folder.                      |
| `appData`   | Where the app keeps its data.              |
| `appCache`  | Where the app keeps files it can recreate. |
| `appLogs`   | Where the app writes logs.                 |

When the environment variable `RN_GPUI_APP_DATA_DIR` is set to a non-empty folder, the three app folders move under it so several copies of an app can run with separate data without overriding `HOME`: `appData` is `$RN_GPUI_APP_DATA_DIR/<id>`, `appCache` is `$RN_GPUI_APP_DATA_DIR/cache/<id>` and `appLogs` is `$RN_GPUI_APP_DATA_DIR/logs/<id>`. They are still created on first read. The other paths are unchanged.

## Dialogs

`dialog` opens the platform's file pickers. Cancelling is not an error: `open` resolves with an empty array, and `save` with `null`.

```js
const [file] = await dialog.open({
  title: 'Choose a document',
  filters: [{ name: 'Text', extensions: ['txt', 'md'] }],
});

const target = await dialog.save({ defaultName: 'export.json' });
```

| `dialog.open` option | Description                        |
| -------------------- | ---------------------------------- |
| `title`              | The title of the dialog.           |
| `defaultPath`        | The folder to start in.            |
| `multiple`           | Allow several files.               |
| `directory`          | Choose a folder instead of a file. |
| `filters`            | `{name, extensions}` entries.      |

`dialog.save` takes `title`, `defaultPath`, `defaultName` and `filters`. On Linux the dialogs use the XDG portal, so GTK is not required.

## Reveal and open

```js
await fs.promises.reveal(path); // show the file in Finder, Explorer or the file manager
await fs.promises.openExternal(path); // open a file or URL with its default application
```

## Downloading

`download(url, path, options)` streams an HTTP response into a file without holding it in memory. The body is written to `<path>.part` and renamed onto `path` when it is complete, so `path` never holds half a file; an existing file is replaced only on success. The partial file is removed when the request fails or is aborted.

```js
const controller = new AbortController();

const { status, headers, bytes } = await fs.download(
  url,
  `${paths.downloads}/report.pdf`,
  {
    headers: { Authorization: `Bearer ${token}` },
    onProgress: (received, total) =>
      setProgress(total > 0 ? received / total : 0),
    signal: controller.signal,
  },
);
```

| Option       | Description                                                          |
| ------------ | -------------------------------------------------------------------- |
| `method`     | `GET` unless set. No request body is sent.                           |
| `headers`    | Request headers.                                                     |
| `onProgress` | `(received, total)`; `total` is `-1` when the server gave no length. |
| `signal`     | Aborting rejects with an `AbortError` within a fraction of a second. |

The promise resolves with the final `status`, the response `headers` (lower-cased) and the `bytes` written. A status outside 200 to 299 rejects with `code` `ERR_HTTP_STATUS` and the `status`, `headers` and the first 2 KiB of the `body`, and writes nothing. Redirects are followed. A connection that closes before the announced length rejects, and the parent folder of `path` must exist. Certificates are checked against the operating system's store.

## Uploading

`upload(url, path, options)` sends a file, or a range of one, as an HTTP request body without holding it in memory. The native side reads the file in 64 KiB blocks while the connection takes them.

```js
const { status, headers } = await fs.upload(url, `${paths.temp}/part-1`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/octet-stream' },
  offset: 0,
  length: 10 * 1024 * 1024,
  onProgress: (sent, total) => setProgress(sent / total),
  signal: controller.signal,
});
```

| Option       | Description                                                          |
| ------------ | -------------------------------------------------------------------- |
| `method`     | `PUT` unless set.                                                    |
| `headers`    | Request headers. `Content-Length` is set from the range.             |
| `offset`     | Where in the file the body starts. Zero unless set.                  |
| `length`     | How many bytes to send. Everything from `offset` unless set.         |
| `onProgress` | `(sent, total)`.                                                     |
| `signal`     | Aborting rejects with an `AbortError` within a fraction of a second. |

The promise resolves with the final `status`, the response `headers` (lower-cased) and the first 2 KiB of the response `body`, whatever the status is, so a caller can read an `ETag` or an error document. A range past the end of the file rejects. Certificates are checked against the operating system's store.

## Watching

`watch(path, listener)` watches a file or folder, as in Node. The listener receives `'rename'` or `'change'` and the file name, and the watcher it returns has a `close()` method.
