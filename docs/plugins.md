# Local plugins

Local plugins contribute daemon RPCs, native app surfaces, workspace panels, Command Center items,
app themes, and composer attachment sources from one `index.ts`. Paseo executes the server contribution in a
subprocess and evaluates the client contribution in the app runtime. Plugin code is trusted code;
this first slice does not sandbox it.

## Install a directory source

Create a typecheckable plugin project, install its development dependencies, then install it into
the daemon. `init` only writes the project files; it does not run the package manager.

```bash
paseo plugin init /absolute/path/to/my-plugin
cd /absolute/path/to/my-plugin
npm install
npm run typecheck
paseo plugin install /absolute/path/to/my-plugin
paseo plugin install /absolute/path/to/my-plugin --id another-runtime-id
paseo plugin ls
```

The daemon stores directory sources under the root `plugins` object:

```json
{
  "pluginsEnabled": true,
  "plugins": {
    "my-plugin": {
      "source": "directory",
      "path": "/absolute/path/to/my-plugin",
      "enabled": true
    }
  }
}
```

The plugin system is disabled unless `pluginsEnabled` is `true`. Changing that root field is
runtime-safe: run `paseo reload` after editing `config.json`. Enabling starts every configured,
enabled plugin; disabling tears them all down without restarting the daemon. Plugin source entries
remain lifecycle-owned and do not reload from manual config edits.

The directory contains an identity-only manifest, one entry point, and local typechecking support:

```text
my-plugin/
  paseo-plugin.json
  index.ts
  main.client.tsx
  paseo-plugin.d.ts
  package.json
  tsconfig.json
```

Paseo compiles TypeScript and TSX when loading the plugin, so these packages are development dependencies only.
The generated declaration file supplies `@getpaseo/plugin` and `@getpaseo/plugin/server` types until the
SDK is distributed as a public package. Regenerate new plugins with the matching Paseo CLI when the
SDK contract changes.

```json
{
  "id": "my-plugin"
}
```

The config key is the runtime plugin ID. The manifest ID is the default selected during install;
`--id` overrides it. Existing configuration is not renamed when the manifest changes, and the
runtime does not compare the two IDs. The same directory can be installed under several config
keys.

Never enable plugins on a user's behalf without explicit permission. Before asking, check the
target daemon's current `pluginsEnabled` value. State that plugins are trusted, unsandboxed code:
backend code can access the daemon machine, while client contributions run inside the Paseo app.

Source changes are explicit. Run `paseo plugin reload <id>` to stop and fully tear down the old
plugin before compiling and starting from disk. A failed reload stays failed; Paseo does not restore
the old code. Use `enable`, `disable`, and `remove` to manage one plugin. Remove deletes only its
configuration, never its source directory. The global `pluginsEnabled` switch remains available.

Server contributions can write to stdout and stderr with normal Node logging. Paseo adds `[paseo]`
entries for loading, ready, stopping, and stopped transitions. Compilation and load failures are
recorded as stderr entries before a subprocess exists. Inspect the recent in-memory
tail from the host plugin settings or with `paseo plugin logs <id>`. Reload, disable, and process
failure retain the tail; removing the plugin clears it. Daemon restarts do not retain the tail, but
structured copies remain in `$PASEO_HOME/daemon.log`. Plugin output can contain secrets, so do not
log credentials or tokens.

## Contribute behavior and UI

Default export one contribution function from `index.ts`. Keep it to contribution wiring. Runtime
code lives behind filename boundaries:

| Suffix         | Owns                                                                 |
| -------------- | -------------------------------------------------------------------- |
| `*.client.tsx` | React, React Native, hooks, styles, surfaces, panels, and callbacks. |
| `*.server.ts`  | Node APIs, filesystem and process access, credentials, and handlers. |
| `*.shared.ts`  | Zod RPC contracts and plain values used by both runtimes.            |

Shared files import contracts from `@getpaseo/plugin/server`. Client files import hooks from
`@getpaseo/plugin`. Plugin UI runs on desktop and mobile across multiple themes: color every
`Text` from `theme.colors.foreground` or `theme.colors.foregroundMuted`, and size layout from
`layout.compact`. See `public-docs/plugins/reference.md`.

| Module                    | Use it for                                               |
| ------------------------- | -------------------------------------------------------- |
| `@getpaseo/plugin`        | hooks and UI types                                       |
| `@getpaseo/plugin/server` | `defineRpc`, `defineAttachmentSource`, and handler types |

The compiler removes client registrations and imports from the server entry point, and server
registrations and imports from the client entry point. Importing a `*.server` module from a client
module, or a `*.client` module from a server module, fails compilation. Top-level React Native calls
such as `StyleSheet.create` belong in `*.client.tsx`; placing them in `index.ts` executes them in the
server bundle.

```ts
import type { PluginContext } from "@getpaseo/plugin";
import { Greeting } from "./greeting.client";
import { createGreeting } from "./greeting.server";
import { greetRpc } from "./greeting.shared";

export default function contribute(plugin: PluginContext) {
  plugin.handle(greetRpc, createGreeting);
  plugin.addSurface("main", Greeting);
  plugin.addSidebarItem({ id: "main", title: "Greeting", icon: "MessageCircle", surface: "main" });
  return () => {};
}
```

The contribution function must return cleanup. Server cleanup may be async; Paseo waits for it when
the plugin is reloaded, disabled, removed, disconnected, or shut down. Cleanup is for resources
created by plugin code. Paseo removes registered contributions, unmounts surfaces, clears query
state, rejects pending RPCs, closes the plugin's daemon session, and stops the subprocess. Cleanup
errors are logged and do not interrupt host teardown.

Paseo owns the route, screen header, Lucide icon validation, close action, theme DTO, layout facts,
and render error boundary. The contributed component owns the complete body below the header.

RPC contracts validate inputs and outputs in both the app and plugin subprocess. `useRpc` returns a
typed async function. Use the host-provided `@tanstack/react-query` for request state and caching;
Paseo gives each plugin installation its own query client.

`usePaseo()` and the handler's `{ paseo }` context expose the same `PaseoApi`: workspaces, agents,
providers, and daemon config. They do not expose connection lifecycle. A surface borrows the
selected host's existing connection; switching the screen's host changes both `usePaseo()` and
`useRpc()` to that host. An offline selected host fails there and never falls through to another
installation. A server handler owns an IPC-backed daemon session for the life of its subprocess.
Use plugin RPC for plugin-specific backend behavior that is not a normal Paseo operation.

Each subprocess gets an exclusively owned `plugin:<id>` session. That identity is reserved from
normal clients, never resumes another session, and is cleaned immediately on exit without reconnect
grace. During daemon startup, plugin sessions may connect while application WebSockets remain
paused; the daemon accepts clients only after configured plugins have settled and the initial
catalog is complete.

When the same plugin contribution exists on multiple hosts, Paseo shows it once in the sidebar and
adds a host picker to the screen header. The selected host supplies the bundle, RPC transport, and
query cache. Plugin code cannot address another host.

Workspace panels and Command Center items remain client contributions. The daemon transports their
compiled bundle without interpreting placement or callbacks. Panel props contain workspace and agent
IDs. Required-selector hooks read normalized client state synchronously and use shallow equality, so a
panel does not subscribe to fields it does not render. Command callbacks materialize their snapshots
only when invoked. Contribution discovery and panel opening never fetch active context through plugin
RPC. Snapshot DTOs are deeply readonly and frozen at runtime so plugin code cannot mutate normalized
app state or a memoized selection. Panels use one persisted
`plugin` workspace-tab target, so reload, disable, removal, and restoration resolve through the
current installed-plugin catalog. A missing contribution renders unavailable inside the tab.

Command Center callbacks use the selected host's existing `PaseoApi` for normal Paseo operations.
They use typed plugin RPC only for plugin-specific backend work. Navigation is limited to the
plugin's registered global surfaces and workspace panels; plugins do not receive Expo Router or
workspace-layout store access.

## Contribute composer attachments

Register a declarative attachment source backed by a plugin RPC. Paseo owns the attachment menu,
search picker, drafts, selected pill, and submission. The plugin returns complete text snapshots;
credentials and vendor API calls stay in the daemon handler.

```ts
import type { PluginContext } from "@getpaseo/plugin";
import { search } from "./issues.server";
import { issues, searchIssues } from "./issues.shared";

export default function contribute(plugin: PluginContext) {
  plugin.handle(searchIssues, search);
  plugin.addAttachmentSource(issues);
  return () => {};
}
```

Attachment sources stay scoped to the composer's host. Unlike sidebar contributions, equal sources
on several hosts are not coalesced. The selected snapshot submits as a text attachment with neutral
external-resource presentation, so it remains readable if the plugin is removed or an older peer
drops the optional presentation fields.

## Contribute a theme

`addTheme` takes an eight-color dark palette and a display name. Unistyles needs every theme at
`StyleSheet.configure` time, so `packages/app/src/styles/theme.ts` reserves one `plugin` slot in
`REGISTERED_THEMES`; selecting a contributed theme expands its palette through the same
`buildDarkSemanticColors`/`buildDarkTheme` pair the built-in dark variants use and rewrites that
slot with `UnistylesRuntime.updateTheme`. One slot covers any number of contributed themes because
only one theme is active at a time. See [unistyles.md](unistyles.md) for the runtime-patching rules
the appearance settings share.

`addTheme` is a client registration, so the compiler strips it from the backend bundle. A daemon
that predates it does not, and the plugin fails to start there. Daemons advertise
`features.pluginThemes` in `server_info`; `usePluginThemes` is the one place the app reads it, and
a host without it contributes no themes.

The selection persists as `theme: "plugin"` plus a `pluginThemeId` of `<pluginId>/theme/<themeId>`,
so equal themes on several hosts coalesce the way sidebar contributions do. Two hosts can answer
that id with different palettes, so picking a theme records its host through
`rememberPluginContributionHost` and resolution prefers it; a peer connecting or dropping then does
not repaint the app. Without a preference the sorted registry snapshot decides, so the result is
stable rather than arrival-ordered. The app resolves that id
against the installed catalog on every change; an id nothing contributes falls back to the default
preference instead of painting the reserved slot's placeholder colors.

See `plugin-examples/local-plugin` for a native surface, `plugin-examples/linear` for a complete
attachment-source example, and `plugin-examples/catppuccin` for a theme.
