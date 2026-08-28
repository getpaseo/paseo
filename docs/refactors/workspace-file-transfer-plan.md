# Workspace file transfer plan

Upload and download files and folders from the **Files** side panel, with the bytes riding the
existing WebSocket binary channel instead of a separate HTTP endpoint.

Target: this fork (`kiawin/paseo`). Not upstreamed as-is — see [Relationship to upstream](#relationship-to-upstream).

## Why the transport changes

Downloads today take a one-shot token over WebSocket, then fetch
`GET /api/files/download?token=` over plain HTTP (`packages/app/src/stores/download-store.ts:86-160`,
`packages/server/src/server/bootstrap.ts:843`). That second origin has to be discovered, reached, and
authenticated separately from the connection the app already has, and it keeps failing:

| Issue                                                                                                                 | Failure                                                           |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [#543](https://github.com/getpaseo/paseo/issues/543) (`p2`, triaged, reconfirmed on 0.5.0)                            | `Download host is unavailable` on relay-only hosts                |
| [#3753](https://github.com/getpaseo/paseo/issues/3753)                                                                | relay vhost stored as `directTcp`; downloads hit the wrong origin |
| [#3521](https://github.com/getpaseo/paseo/issues/3521)                                                                | iOS ATS `-1022` over Tailscale                                    |
| [#1954](https://github.com/getpaseo/paseo/issues/1954)                                                                | `ERR_INVALID_CHAR` on `Content-Disposition` for CJK filenames     |
| [#1350](https://github.com/getpaseo/paseo/issues/1350), [#959](https://github.com/getpaseo/paseo/issues/959) (closed) | 401 with a daemon password / behind a reverse proxy               |
| [#3294](https://github.com/getpaseo/paseo/issues/3294) (closed)                                                       | download replaced the desktop window with a 404                   |

The relay carries only `/health` and `/ws` (`packages/relay/src/cloudflare-adapter.ts:584-591`), so on a
relay connection there is no HTTP path to fix. Uploads already avoid all of this by sending bytes as
binary frames (`packages/client/src/daemon-client.ts:4472`).

VS Code reached the same conclusion: every remote file operation is a call on the one multiplexed
channel — `channel.call('readFile')`, `channel.listen('readFileStream')`, `channel.call('writeFile')`
(`src/vs/platform/files/common/diskFileSystemProviderClient.ts:96,106,161`). No side channel, no tokens.

## Acceptance

- Download a file from the Files panel on a **relay-only** connection, on web, Electron, iOS and Android.
- Download a folder; get a `.zip` containing it, on every client.
- Upload one or more files into a chosen folder in the workspace tree; the listing refreshes.
- Upload a folder tree, preserving structure, on web and Electron.
- Non-ASCII filenames survive both directions unchanged (CJK, spaces, emoji).
- A transfer in flight can be cancelled, and cancelling stops the daemon reading or writing.
- A 2 GB download to a slow phone does not grow daemon, relay, or client memory without bound.

## Non-goals

- Resumable or background transfers. A dropped connection fails the transfer.
- Folder upload on iOS/Android — the OS pickers hand back files, not trees.
- `.gitignore` or `.git` filtering on folder download. Everything under the folder goes in.
- File System Access API directory recursion as a zip alternative (see [Folder download](#folder-download)).
- Fixing attachment-upload filename mangling ([#2961](https://github.com/getpaseo/paseo/issues/2961)) —
  adjacent, different code path. Our new path must not repeat it.

## Protocol

Two request/response pairs and two one-way messages, per [docs/rpc-namespacing.md](../rpc-namespacing.md).
Bytes reuse the existing `FileTransferOpcode` frames (`packages/protocol/src/binary-frames/file-transfer.ts`)
in both directions.

| Message                                   | Direction       | Payload                                                                                                           |
| ----------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------- |
| `fs.entry.download.request` / `.response` | client → daemon | `{ cwd, path, requestId }` → `{ kind: "file" \| "archive", fileName, mimeType, size \| null, error }`             |
| `fs.entry.upload.request` / `.response`   | client → daemon | `{ cwd, path, mimeType, size, modifiedAt, overwrite, requestId }` → `{ path, size, modifiedAt, revision, error }` |
| `fs.transfer.ack`                         | either          | `{ requestId, bytesReceived }`                                                                                    |
| `fs.transfer.cancel`                      | either          | `{ requestId }`                                                                                                   |

`kind` is decided by the daemon from a `stat`, not asked for by the client. An archive has no size until
it is written, so the response carries `size: null` and `FileBeginMetadataSchema` gains an optional
`sizeKnown?: boolean` — a new optional field, never narrowing, per the protocol contract in
[CLAUDE.md](../../CLAUDE.md).

`overwrite` is `"fail" | "replace" | "rename"`. Default `"fail"`; the app asks and re-sends.

Feature gate: `server_info.features.workspaceFileTransfer` (`packages/protocol/src/messages.ts:3295`).
Gate once, then run the feature or tell the user to update the host. The one exception is download,
which keeps the HTTP path as a tagged fallback while old daemons are still in the wild:

```ts
// COMPAT(httpFileDownload): added in v0.5.x, remove after 2027-02-01 once the daemon floor ships fs.entry.download.
```

### Flow control

The ack is the part VS Code does not have, and we need it. Their remote is a direct socket, so TCP
backpressure reaches the sender — the download path is deliberately fire-and-forget
(`diskFileSystemProviderServer.ts:122` fires chunk events; `diskFileSystemProviderClient.ts:111` ignores
the write return). We have a relay in the middle that the daemon writes to instead of the client, and
no drain signal, so a slow phone grows DO memory instead.

Rule, both directions: the sender stops once **8 MiB** is unacked, and resumes on the next
`fs.transfer.ack`. The receiver acks every 2 MiB and at end-of-stream.

This also fixes an existing gap: `uploadFile` currently fires every chunk in a tight loop with no await
(`packages/client/src/daemon-client.ts:4505-4517`). VS Code never does this — its remote writes are
awaited per-chunk RPCs, implicitly acked.

Daemon → relay backpressure already exists and stays: `sendBinaryToClientAndWait`
(`packages/server/src/server/websocket-server.ts:1168`) over `getTransportBufferedAmount`
(`packages/server/src/server/relay-transport.ts:446`).

### Sizing

| Constant                  | Value   | Rationale                                                                                                                                                                          |
| ------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chunk                     | 256 KiB | Already `FILE_EXPLORER_STREAM_CHUNK_BYTES` (`file-explorer/service.ts:97`); VS Code uses the same; PR [#2436](https://github.com/getpaseo/paseo/pull/2436) picked it independently |
| Buffered/unbuffered split | 1 MB    | Below it, one write beats stream setup — VS Code's threshold both directions                                                                                                       |
| Unacked window            | 8 MiB   | Well under the relay's 32 MiB frame ceiling (`packages/server/src/utils/checkout-git.ts:2026`)                                                                                     |
| Progress repaint          | 1/sec   | The toast currently repaints per callback                                                                                                                                          |

No relay change is needed. It already forwards binary unchanged
(`cloudflare-adapter.ts:448`), and the E2EE channel negotiates `binaryCiphertext`
(`encrypted-channel.ts:98,170`) so ciphertext rides as an `ArrayBuffer` with a flat 40-byte overhead
rather than 1.34× base64 expansion. `bufferFrame` only engages when the daemon leg is absent.

## Folder download

**Zip on the daemon, streamed.** VS Code does not zip — for a folder it opens `showDirectoryPicker()`
and recurses, creating a `FileSystemDirectoryHandle` per subfolder and writing each file
(`fileImportExport.ts:772-790`). When the File System Access API is missing, VS Code web silently
downloads nothing for a folder.

That trade does not survive here. Paseo's primary client is a phone, and iOS/Android have no directory
handle at all; Firefox and Safari web are in the same position. Zip is the only path that works on every
client, so it is the only path we build. FSA recursion stays available as a later enhancement for
Chromium web and Electron, where it would buy per-file progress and no server-side archive cost.

Add `yazl` to `packages/server` — streaming, no transitive deps, handles zip64 past 4 GB. The
alternative is a hand-rolled store-only zip (~200 lines, CRC32 plus zip64 headers); that avoids a
dependency but puts archive-format correctness on us for no user-visible gain.

Archive rules: skip symlinks entirely, cap entry count and total bytes, deterministic entry order,
paths relative to the folder, mtimes preserved.

## Slices

Each slice leaves the tree runnable.

| #   | Slice                                                  | Delivers                          | Risk   |
| --- | ------------------------------------------------------ | --------------------------------- | ------ |
| 1   | Protocol messages, feature flag, client streaming seam | nothing user-visible              | low    |
| 2   | Download files over WS                                 | closes the #543 cluster for files | medium |
| 3   | Folder download as zip                                 | folder Download menu item         | medium |
| 4   | Upload files into the workspace                        | Upload files… menu item           | medium |
| 5   | Folder upload sources (web, Electron)                  | Upload folder… menu item          | medium |
| 6   | Drag-and-drop onto the explorer                        | drop files/folders on a tree row  | high   |

### Slice 1 — protocol and the client seam

`packages/protocol/src/messages.ts` — the four messages, the feature flag, the optional `sizeKnown` on
`FileBeginMetadataSchema`. Regenerate zod-aot validation ([docs/protocol-validation.md](../protocol-validation.md)).

`packages/client/src/daemon-client.ts` — today a daemon→client transfer accumulates every chunk in
`activeBinaryFileTransfers` and concatenates at the end (`:5773-5820`), which is why both open PRs have
to cap file size. Replace with a **sink registry**: `registerBinaryFileSink(requestId, { onBegin, onChunk,
onEnd, onError })`. `readFile` keeps its current behavior by registering a buffering sink, so explorer
preview is untouched.

**Proof:** existing explorer preview tests; `readFile` byte-identical on a binary fixture.

### Slice 2 — download files over WS

Server: `handleEntryDownloadRequest` in
`packages/server/src/server/session/files/workspace-files-session.ts`, streaming through the existing
awaited `emitBinary` used by `streamExplorerFile` (`:273-303`). Cancel and ack handlers keyed by `requestId`.

Client: `downloadEntry({ cwd, path, sink, signal })`.

App: `packages/app/src/stores/download-store.ts` gets a WS path — web accumulates Blob parts and clicks
an object URL; native writes chunks to an `expo-file-system` handle, then `Sharing.shareAsync` as today.
Keep the HTTP path behind the COMPAT tag for daemons without the feature.

**Proof:** `packages/server/src/server/daemon-e2e/` download test (there is already
`file-download.e2e.test.ts`); manual download over a real relay connection.

### Slice 3 — folder download

`packages/server/src/server/file-explorer/service.ts` — `getDownloadableFileInfo` (`:534`) currently
throws `"Requested path is not a file"`; widen it to report `kind`, and add
`streamDirectoryArchive({ root, relativePath, signal })` returning an async iterable of zip bytes.

App: drop the `entry.kind !== "file"` guard (`packages/app/src/components/file-explorer-pane.tsx:644`)
and the `availableFile` gate on the menu item
(`packages/app/src/components/file-actions-menu.tsx:160`). Hide percent and ETA when `size` is null.

**Proof:** unit test unzipping a fixture tree; symlink-escape test; cancellation mid-archive.

### Slice 4 — upload files into the workspace

`FileUploadStore` (`packages/server/src/server/file-upload/index.ts`) writes only to
`$PASEO_HOME/uploads/<id>/` and is the composer's attachment staging area. Leave it alone. Workspace
writes belong in `file-explorer/service.ts`, which already owns scoped paths and atomic writes: add
`createUploadSink({ root, relativePath, overwrite })` returning `{ write, commit, abort }`, using the
same temp-file-then-rename as `writeFile`.

`handleFileTransferFrame` (`workspace-files-session.ts:356`) currently hands every frame to the
attachment store. It needs a router keyed by which request registered the `requestId`.

App: `stores/upload-store.ts` mirroring the download store, reusing the toast; `uploadEntries` in
`hooks/use-file-explorer-actions.ts`; menu items on folders and the pane background; re-list the parent
on completion. New i18n keys across all ten locales in `packages/app/src/i18n/resources/`.

**Proof:** path-escape and symlink-parent unit tests; each `overwrite` mode; a CJK filename round-trip.

### Slice 5 — folder upload sources

`packages/app/src/hooks/use-file-picker.ts` gains `pickDirectory()`: web uses
`<input webkitdirectory>` and keeps `webkitRelativePath`; Electron already accepts
`dialog.open({ directory: true })` (`packages/desktop/src/features/dialogs.ts:68`) and needs a host API
for the recursive walk (`readDesktopFileBytes` exists). Not offered on iOS/Android.

Upload files up to **20 in parallel**, folders **sequentially** — VS Code's shape, and their reason
holds: folder sizes are unknown until walked (`fileImportExport.ts:74,301-308`).

### Slice 6 — drag and drop onto the explorer

`packages/app/src/components/file-drop/use-drop-listeners.ts` converts drops into _image attachments_
only, and the composer is the sole `useFileDrop` consumer (`packages/app/src/composer/index.tsx:2228`).
Needs a raw-file sink variant plus `webkitGetAsEntry` recursion for dropped folders. Largest app-side
change; it is last because slices 4 and 5 make it a second entry point rather than the only one.

## Security

- Every destination path resolves through `resolveScopedPath`; reject `..`, absolute paths, `~`, and
  symlinked parents. `O_NOFOLLOW` on create, matching `READ_FILE_OPEN_FLAGS`
  (`file-explorer/service.ts:99`).
- Uploads write into the user's repository. Feature-gated, never silently overwriting.
- Cap upload size; check free space; abort on disconnect (the stale-upload timeout in
  `file-upload/index.ts` is the pattern).
- Archive: skip symlinks rather than following them out of the root; cap entries and total bytes.
- Preserve filenames byte-for-byte. The `Content-Disposition` sanitizer that mangles CJK
  (`bootstrap.ts`) disappears with the HTTP path; do not reintroduce that class of bug in the WS path.

## Testing

Per [CLAUDE.md](../../CLAUDE.md), run only the files you touched — `npx vitest run <file> --bail=1`.
Push to CI for the full suite.

- Protocol: schema round-trip and old-client parse, following `messages.file-editing.test.ts`.
- Server: scoped-path escape, symlinks, overwrite modes, archive contents, cancellation.
- Client: sink lifecycle, frame routing, ack windowing, abort mid-stream.
- App: store reducers for both transfer stores.
- E2E: `daemon-e2e/` for download and upload over a real in-process daemon.

## Relationship to upstream

Two open PRs already move download onto the WS channel, both stale since 2026-08-01 with no human
review: [#2436](https://github.com/getpaseo/paseo/pull/2436) (draft, +442/−81, `relayFileDownloads`
feature gate, 256 KiB frames, 4 MiB high-water mark) and
[#1863](https://github.com/getpaseo/paseo/pull/1863) (+610/−18, 50 MB cap).

Both treat WS as a _fallback_ with HTTP staying primary, and both buffer the whole file in client
memory — which is why both need a size cap, and why neither could grow into folder support. This plan
makes WS primary and streams to a sink instead. Read #2436 before starting slice 2; its connection
resolution work is worth borrowing even though the transport decision differs.

Nothing upstream requests upload-into-workspace or folder download — no issue, no discussion. If this
is ever upstreamed, that half needs an issue and design alignment first, per the PR template.
