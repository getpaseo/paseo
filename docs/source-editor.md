# Source editor

The source editor has one CodeMirror runtime and two hosts:

- Web mounts the runtime directly into the page.
- iOS and Android mount the same runtime from a generated, offline HTML document in a WebView.

Keep editor mechanics in `packages/app/src/source-editor/`. File loading, conflict handling, and
persistence belong to the file pane's `FileEditorModel`. The source editor receives a document and
emits edits; it does not know about workspaces or daemon RPCs.

## Native bridge

The native bridge sends compact change ranges in normalized LF coordinates. The host-side document
mirror validates and applies them, then restores the file's original line separator before calling
the file model. Full document replacements cross the bridge only for mount and external changes.

Every message carries an editor key. Ignore messages from an old key after remounting or switching
files. Keep the bridge protocol private to this module; React components outside it use
`SourceEditorProps`.

Do not expose raw CodeMirror extensions as the cross-platform API. Add named capabilities to the
source editor contract, then implement them once in the shared runtime or explicitly in each host.

## Embedded bundle

After changing the CodeMirror runtime, bridge protocol, or WebView entry point, run:

```bash
npm --prefix packages/app run build:source-editor-webview
```

The generated `webview-html.ts` is committed so native builds do not need a runtime bundler or
network access. `build:source-editor-webview:check` fails when the committed artifact is stale, and
EAS post-install rebuilds all embedded WebViews.
