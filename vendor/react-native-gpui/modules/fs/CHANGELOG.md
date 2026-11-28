# Changelog

All notable changes to `@react-native-gpui/fs` are listed here. Each version's section becomes the notes of its GitHub release.

## Unreleased

- Honour `RN_GPUI_APP_DATA_DIR`: when set and non-empty, `paths.appData`, `paths.appCache` and `paths.appLogs` become `$RN_GPUI_APP_DATA_DIR/<id>`, `.../cache/<id>` and `.../logs/<id>`, so several copies of an app can run with separate data.

## 0.0.1-alpha.1 - 2026-11-12

- Add `upload(url, path, options)`, which streams a file, or a range of one, as an HTTP request body in small blocks, reports progress, honours an `AbortSignal` and resolves with the response status, headers and the start of its body.
- Add `download(url, path, options)`, which streams an HTTP response to a file through `<path>.part`, reports progress, honours an `AbortSignal` and rejects on a non-2xx status.

## 0.0.1-alpha.0 - 2026-11-01

- First release.
- File system access for desktop apps.
