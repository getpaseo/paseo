# PDF file panel example

Requires Paseo 0.13.0 or later. Install this directory with
`paseo plugin install /absolute/path/to/plugin-examples/pdf-panel`, then open a `.pdf` in Files.

The panel resolves the file's local URL with `useFileUrl`, shows `Loading` until it does, and passes
it to `DocumentFrame` on web and iOS. Android shows the filename, size, and a message that inline
PDF rendering is unavailable. The plugin does not construct daemon URLs.

See the [file panel reference](https://paseo.sh/docs/plugins/reference#file-panels).

Inline PDF rendering needs a daemon from Paseo 0.13.0 or later; see the
[DocumentFrame reference](https://paseo.sh/docs/plugins/reference#documentframe).
