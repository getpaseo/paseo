# Plugins

Plugins extend Paseo's UI without a Paseo release. A plugin contributes a file preview or a sidebar panel; the daemon installs and serves it, the client renders it in a sandbox.

This doc owns the plugin contract: the manifest, the sandbox, the host bridge, and the registry. For adding an agent backend instead, read [providers.md](providers.md).

## What a plugin is

A directory under `$PASEO_HOME/plugins/<id>/` containing a `paseo-plugin.json` manifest and one self-contained HTML file per contribution.

```
$PASEO_HOME/plugins/
├── installed.json          # enabled state and install source, daemon-owned
└── csv-table/
    ├── paseo-plugin.json
    └── preview.html
```

```json
{
  "id": "csv-table",
  "name": "CSV Table",
  "version": "1.0.0",
  "description": "Render CSV and TSV files as a sortable table.",
  "author": "you",
  "license": "MIT",
  "paseoVersion": ">=0.2.6",
  "contributes": {
    "filePreviews": [
      { "id": "table", "title": "Table", "extensions": [".csv", ".tsv"], "entry": "preview.html" }
    ],
    "sidebarPanels": [{ "id": "pet", "title": "Pet", "icon": "cat", "entry": "pet.html" }]
  }
}
```

Schemas are in `packages/protocol/src/plugin/types.ts` and are the source of truth for what parses.

### One HTML file per contribution

An entry is a flat `*.html` filename in the plugin directory. No subdirectories, no separate JS or CSS files, no images on disk. Bundle everything into the HTML.

This is the constraint that keeps the rest of the system small: there is no asset server, no path resolution, no traversal surface, and no MIME handling. The daemon reads one file and sends its text.

Bundle with whatever you like; `esbuild --bundle --minify` into an inline `<script>` is enough.

## The sandbox

Plugin HTML never runs in the app's own context. The client renders it in a sandboxed frame with no network and no storage:

| Platform      | Host                                                              |
| ------------- | ----------------------------------------------------------------- |
| Web, Electron | `<iframe sandbox="allow-scripts" srcDoc=...>` — opaque origin     |
| iOS, Android  | `react-native-webview` with navigation locked to the initial load |

Both get the same injected CSP: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:`. A plugin cannot fetch, cannot navigate, cannot read cookies, and cannot reach the daemon except through the bridge below.

Deliberately absent from the iframe sandbox: `allow-same-origin` (would give the plugin an origin and therefore storage and same-origin reach), `allow-popups`, `allow-top-navigation`, `allow-forms`, `allow-modals`.

## The host bridge

One `postMessage` channel. Every message is `{ paseo: 1, type, ... }`; anything else is ignored.

Host to plugin:

| Message  | When                       | Carries                                                    |
| -------- | -------------------------- | ---------------------------------------------------------- |
| `init`   | after the plugin's `ready` | `context` (see below) and `theme` (resolved design tokens) |
| `update` | context changed            | same `context` shape                                       |

Plugin to host:

| Message     | Effect                                                   |
| ----------- | -------------------------------------------------------- |
| `ready`     | plugin has listeners attached; host replies with `init`  |
| `open-file` | `{ path, lineStart? }` — opens the file in the file pane |
| `resize`    | `{ height }` — sidebar panels only                       |

`context` for a file preview is `{ kind: "file-preview", path, content }`. For a sidebar panel it is `{ kind: "sidebar-panel", cwd, workspaceId }`.

The bridge is intentionally this small. A plugin gets the content it was opened on and one navigation verb. It does not get the daemon client, the agent timeline, or the filesystem. Widening it is a product decision, not a plumbing one.

## Contribution points

**File preview.** The file pane resolves a preview by extension. A plugin preview wins over the built-in syntax-highlighted view for extensions it claims, and the user can switch back from the file pane toolbar. Two plugins claiming the same extension resolve alphabetically by plugin id; the loser is reported in Settings.

**Sidebar panel.** One extra tab in the explorer sidebar next to Changes, Files, and PR.

Both live behind the `plugins` capability flag on `server_info.features`. An old daemon means no plugins UI at all, not a degraded one.

## Installing

Three paths, all landing in the same directory:

- **Registry.** Settings → Plugins → Browse. The daemon fetches the registry index, and installing downloads each file and verifies its SHA-256 against the index before writing.
- **CLI.** `paseo plugin install <id>`, plus `ls`, `enable`, `disable`, `uninstall`.
- **By hand.** Drop a directory into `$PASEO_HOME/plugins/` and restart the daemon, or hit `paseo plugin ls` which rescans. This is how you develop one.

The registry index defaults to `https://plugins.paseo.sh/index.json` and is overridable with `daemon.plugins.registryUrl` in `config.json` so you can self-host or point at a file during development.

A plugin whose `paseoVersion` does not match, whose manifest stopped parsing, or whose entry file is missing stays listed with an `unavailableReason` instead of disappearing. Silent disappearance is worse than a visible broken row.

## Trust

Installing a plugin means trusting whoever published it with what the bridge exposes: the content of files you preview with it, and the ability to ask the app to open a path. It cannot exfiltrate any of that, because the sandbox denies network access.

The registry operator is a trust boundary — the index says which bytes are the plugin. SHA-256 verification protects the download, not the publisher's intent. See [SECURITY.md](../SECURITY.md).

## Writing one

`examples/plugins/hello-paseo/` is a working plugin with both contribution kinds. Copy it, change the id, and point `daemon.plugins.registryUrl` at a local index to test the install path end to end.
