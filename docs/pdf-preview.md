# PDF preview

Opening a `.pdf` in the file panel hands the bytes to the platform's own PDF
viewer. There is no bundled renderer: Chromium's PDFium, Safari's PDFKit, and
WKWebView already do this better than a canvas renderer would, and they bring
text selection, find-in-page, print, and native zoom with them.

The cost of that choice is **Android has no PDF preview** — see below.

## One shell per platform

`components/pdf-preview` resolves through Metro's platform extensions. All three
take the same props (`pdf/pdf-preview-props.ts`) and the pane doesn't know which
one it got:

| File                  | Platforms                        | How it renders                                                                       |
| --------------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| `pdf-preview.web.tsx` | browser, Electron                | blob URL from the bytes in an `<iframe>`; Chromium/WebKit renders it                 |
| `pdf-preview.ios.tsx` | iOS                              | bytes staged to a file, `WebView` pointed at the `file://` URL; WKWebView renders it |
| `pdf-preview.tsx`     | Android (and any other platform) | "not supported on this platform yet"                                                 |

Three details are load-bearing:

- **The blob must be typed `application/pdf`** (`pdf/pdf-object-url.ts`). The
  mime is the only thing telling the browser to open its viewer instead of
  downloading the file.
- **The web iframe is deliberately not sandboxed.** A sandboxed browsing context
  blocks plugin content, and the built-in PDF viewer _is_ plugin content. The
  document is a blob minted from bytes already in the renderer, and pdf viewing
  does not execute script from the file.
- **Electron needs `webPreferences.plugins: true`** (set on the main window in
  `packages/desktop/src/main.ts`). Without it Chromium's PDF viewer is disabled
  and the iframe renders nothing. NPAPI/PPAPI no longer exist, so the flag
  admits the built-in viewer and nothing else.

iOS needs the bytes on disk because WKWebView renders from a URL, not from
memory. The shell stages them through the existing attachment store — the same
machinery image previews use — which yields a `file://` URI, and passes the
containing directory as `allowingReadAccessToURL`; WKWebView refuses a file URL
it has not been granted. The staged copy keeps its `.pdf` extension
(`EXTENSION_BY_MIME_TYPE` in `attachments/local-file-attachment-store.ts`),
which is how the viewer decides what the file is.

The staged file is content-addressed by the pane's preview id, so reopening the
same PDF reuses it. It also outlives the preview, exactly like a staged image
preview — the attachment store's GC is the only thing that reclaims it, which is
more noticeable for a 20 MB PDF than for a thumbnail.

Web and Electron deliberately skip the attachment store: the bytes are already
in the renderer process, so `URL.createObjectURL` avoids a persist-then-read
round trip (on Electron that round trip would be the whole file as base64 over
IPC).

## Android

Android's WebView has never shipped a PDF viewer — point it at a PDF and it
downloads rather than renders. There is no system surface to hand the bytes to,
so the base shell shows an unsupported message. This is a known, accepted gap.

The message carries a **Download** button (`pdf/use-pdf-download.ts`), which is
the way out: the download store fetches the file and then calls
`Sharing.shareAsync` with its mime type, and Android's share sheet offers
whatever PDF apps are installed. That mime comes from `getDownloadableFileInfo`
on the daemon, which now returns `application/pdf` rather than
`application/octet-stream` — without it Android offers generic file handlers
instead of PDF viewers. The iOS shell shows the same button if staging fails.

The button is absent when the file sits outside the workspace root: download
tokens are scoped to that root, so there is nothing the daemon would issue.

Closing it needs a real renderer, not a tweak: either pdf.js inside a WebView —
which means an esbuild-bundled viewer document, since Metro cannot emit the
worker script pdf.js wants — or a native module over Android's `PdfRenderer`.
Both are Android-only work; nothing about the web or iOS shells needs to change
to accommodate one.

## What this costs in testability

Headless Chromium does not ship the PDF viewer — setting an iframe to a blob PDF
kills the page target outright. Both the vitest browser project and the
Playwright e2e project run headless, so **the rendering path has no automated
coverage on any platform.** What is covered is our own logic: the blob URL's
mime and lifecycle (`pdf/pdf-object-url.test.ts`), the read-grant directory
(`pdf/pdf-preview-props.test.ts`), and mime detection (`pdf/pdf-mime.test.ts`).

Verifying a change here means opening a PDF in a real browser, a real Electron
build, and a real iOS device or simulator.

## Transport: why file reads are chunked

The daemon's file-read path used to emit a whole file as a single binary frame.
That is fine for a 40 KB screenshot and fatal for a PDF: the daemon terminates
any physical socket whose outbound buffer passes
`MAX_PHYSICAL_SOCKET_BUFFERED_BYTES` (8 MiB), so a large single-frame read
killed the very connection it was answering on.

`session/files/file-transfer-emitter.ts` emits `FileBegin`, N × 256 KiB
`FileChunk`, `FileEnd`, and paces the chunks against the client's buffered
amount — the same signal the terminal uses to decide a client is not keeping up.
A client that stops draining for 30 s gets the transfer aborted with an error
response rather than a socket that hangs waiting for `FileEnd`.

Two bounds worth knowing:

- `MAX_PREVIEWABLE_FILE_BYTES` (32 MiB, `file-explorer/service.ts`) is checked
  against `stat` before any bytes are read. Downloads are not affected — they
  stream from disk through `/api/files/download`.
- Clients accumulate chunks and size the result from the chunks themselves, not
  from the advertised size, so a file that changes mid-read cannot truncate the
  payload.

## Mixed versions

The mime **is** the capability check — there is no `server_info.features` flag,
because a daemon that predates this feature simply never sends
`application/pdf`. A new app against an old daemon therefore reaches the
"binary preview unavailable" branch, and the pane says "Update the host to
preview PDFs" when the path ends in `.pdf`. An old app against a new daemon
ignores the mime it doesn't know and shows the same generic binary state. No
fallback renderer exists in either direction.

## Adding another previewable binary type

Add the extension to `BINARY_MIME_TYPES` in
`packages/server/src/server/file-explorer/service.ts` and branch on the mime in
the app. **Do not add a new value to the wire `kind` enum**
(`"text" | "image" | "binary"`): widening it breaks parsing on older clients.
The kind stays `"binary"`, the mime carries the meaning, and a client that
doesn't recognize the mime falls back to "Binary preview unavailable".

Note that for declared binary extensions the mime is decided by extension
before content sniffing runs, so an all-ASCII PDF still arrives as a PDF rather
than as `text/plain`.
