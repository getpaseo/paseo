# Plugins

Local plugins contribute daemon RPCs, native app surfaces, workspace panels, Command Center items,
client slash commands, timeline items, header buttons, composer pills, app themes, composer attachment sources,
settings screens, and Git Forge providers. Paseo executes `index.server.ts` in a subprocess and
`index.client.tsx` in every connected app.

> **Trust every plugin you add.** `paseo plugin add` and `paseo plugin install` mean “I trust this codebase.” Plugins are unsandboxed: server code and preparation commands run with the daemon user's access on the daemon host, and client contributions run inside Paseo. The repository's dependencies and future updates are part of that trust decision. With `--host`, preparation runs on that remote daemon host.

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

The directory contains a manifest declaring identity and Paseo requirements, one optional entry per runtime, runtime-owned
directories, and local typechecking support. At least one entry is required.

```text
my-plugin/
  paseo-plugin.json
  package.json
  tsconfig.json
  index.client.tsx
  index.server.ts
  client/greeting.tsx
  server/greeting.ts
  shared/greeting.ts
```

The generated `package.json` installs `@getpaseo/plugin` and the other host modules as development
dependencies for local typechecking and tests. Paseo compiles TypeScript and TSX and supplies the
runtime modules, so consumers do not install these packages when adding the plugin.

```json
{
  "id": "my-plugin",
  "requirements": { "paseo": ">=0.8.0" }
}
```

Declare the supported Paseo range and keep it current when adopting newer APIs. See the
[requirements contract](../public-docs/plugins/reference.md#requirements), including legacy
manifests and prerelease matching.

The config key is the runtime plugin ID. The manifest ID is the default selected during install;
`--id` overrides it. Existing configuration is not renamed when the manifest changes, and the
runtime does not compare the two IDs. The same directory can be installed under several config
keys.

Never enable plugins on a user's behalf without explicit permission. Before asking, check the
target daemon's current `pluginsEnabled` value. State that plugins are trusted, unsandboxed code:
backend code can access the daemon machine, while client contributions run inside the Paseo app.

Source changes are explicit. Run `paseo plugin reload <id>` to stop and fully tear down the old
plugin before compiling and starting from disk. A failed reload stays failed; Paseo does not restore
the old code. Use `enable`, `disable`, and `remove` to manage one plugin. Removing a directory source
never deletes it. The global `pluginsEnabled` switch remains available.

## Install a Git source

GitHub repositories use an `owner/repository` shorthand. Other hosts use a Git URL. An existing
directory always wins over shorthand resolution.

```bash
paseo plugin add owner/repository
paseo plugin add https://gitlab.com/group/repository.git
paseo plugin add https://git.example.com/owner/repository.git
paseo plugin add owner/monorepo:plugins/review
paseo plugin add owner/repository --ref main
paseo plugin ls
paseo plugin update review
paseo plugin update --all
```

Append `:relative/path` to the source when the plugin lives below the repository root.

`--ref` chooses the initial branch, tag, or commit once. Ordinary updates resolve the remote's
current default HEAD and ask for approval. `ls` reports the installed commit without contacting the remote.
Removing a Git source deletes Paseo's managed checkout.

## Managed source ownership

The [public source reference](../public-docs/plugins/reference.md#plugin-sources) owns identifier
syntax and npm prerequisites; the [publishing guide](../public-docs/plugins/publishing.md) owns distribution. Both clients send the source unchanged
through `installPluginSource`; only the daemon resolves host paths and acquires sources.

`ManagedPluginSources` owns acquisition and offline source description. Config stores the active
directory; sources.json stores managed kind and the Git acquisition remote. The remote is needed
because authenticated clones may have a rewritten placeholder origin. Fixed owned directory layout
provides the selected subdirectory, npm package name and cleanup root. Git HEAD and the installed
npm package.json checked against package-lock.json provide the current revision. Keep the complete
npm dependency tree and lockfile after staging activation. No install selector governs updates.

The loader sees only the configured directory and never invokes npm. npm lifecycle scripts are
disabled during acquisition; manifest preparation owns required commands before validation.

List responses retain the closed `source: directory | git` enum. The optional `installation`
projection carries identity and current revision. Old npm metadata remains accepted but is no longer
emitted. Installation uses `features.pluginSourceInstallation`; reviewed preview/apply uses
`features.pluginSourceUpdates`, gated by the SDK and CLI entry. The old immediate-update request
returns update-client guidance. Basic management remains independently available.

Preview returns exact targets and expected installed identity/root/revision. Apply validates those
values, acquires the displayed artifact or commit, then rechecks state before activation. No review
session is stored in the daemon. PluginService owns activation/recovery and independent bulk results.

### Declare Git preparation

Most plugins should omit `build`. Use it only when the staged checkout must install a dependency
that Paseo does not provide, generate source or assets, or perform another required preparation
step:

```json
{
  "id": "review",
  "requirements": { "paseo": ">=0.8.0" },
  "build": [
    ["npm", "ci"],
    ["npm", "run", "build"]
  ]
}
```

`build` is an optional list of argv arrays. Each array must contain at least one non-empty string;
shell command strings are rejected. Paseo starts the executable directly, without a shell, from the
plugin directory in the staged checkout. It never detects lockfiles or chooses a package manager.

On install and every update, Paseo resolves the exact Git revision and manifest, runs the declared
commands, then validates, compiles, and activates the candidate. It logs each argv command and its
output in the daemon log. If a command fails, the error includes its output, Paseo discards the
candidate, and the existing installed and running version stays untouched. On a remote daemon, all
of this happens on the remote daemon host.

Server contributions can write to stdout and stderr with normal Node logging. Paseo adds `[paseo]`
entries for loading, ready, stopping, and stopped transitions. Compilation and load failures are
recorded as stderr entries before a subprocess exists. Inspect the recent in-memory
tail from the host plugin settings or with `paseo plugin logs <id>`. Git preparation commands are
recorded in `$PASEO_HOME/daemon.log` before a plugin exists, rather than the plugin log tail. Reload, disable, and process
failure retain the tail; removing the plugin clears it. Daemon restarts do not retain the tail, but
structured copies remain in `$PASEO_HOME/daemon.log`. Plugin output can contain secrets, so do not
log credentials or tokens.

## Contribute behavior and UI

Default export one contribution function from each runtime entry. Keep the entries to registration
wiring. Runtime code lives behind directory boundaries:

| Path                             | Owns                                                                 |
| -------------------------------- | -------------------------------------------------------------------- |
| `index.client.tsx` and `client/` | React, React Native, hooks, styles, surfaces, panels, and callbacks. |
| `index.server.ts` and `server/`  | Node APIs, filesystem and process access, credentials, and handlers. |
| `shared/`                        | Zod RPC contracts and plain values used by both runtimes.            |

Do not put any other code modules in the plugin root.

Shared files import contract helpers and types from `@getpaseo/plugin`. Server handler files import
`PluginHandlerContext` from `@getpaseo/plugin/server`. Client files import Paseo UI from
`@getpaseo/plugin/client/react-native`. Its `Icon` resolves a Lucide name using the client's installed icon
set; an unknown name renders nothing so it cannot break the plugin surface.
Its controlled modal keeps presentation metadata on `<Modal title="…" icon={…}>` and body UI in
`<Modal.Content>`. Body layout, sheet-aware scrolling, overlays, image and file picking, image
preview, and clipboard actions follow the
[host UI contract](../public-docs/plugins/reference.md#host-ui).
`pickImages` hands back base64 bytes with every image because plugin code has no file API to read
the picker's local `uri`. `pickFiles` hands back a `readBase64(offset, length)` reader instead:
a document can be tens of megabytes, and plugins upload through their own RPC in chunks, so one
base64 string of the whole file would only be split again. Every `layout` comes from
`usePluginLayout` (`packages/app/src/plugins/layout.ts`), which is where the safe-area insets
join it.
Plugin UI runs on desktop and mobile across multiple themes: color every `Text` from
`theme.colors.foreground` or `theme.colors.foregroundMuted`, and size layout from `layout.compact`.
See `public-docs/plugins/reference.md`.

### SDK import boundaries

Classify every SDK export before adding it. All client entry points and implementations live under
`client/`; all server entry points and implementations live under `server/`. The package root is shared code: plain data types,
Zod schemas, and functions that run in both runtimes. A type-only import is still an architectural
dependency; shared types must not refer to React components, hooks, Node APIs, or server contexts.

| Entry                                                | Owns                                                                       | May depend on          |
| ---------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------- |
| `@getpaseo/plugin`                                   | Shared data, schemas, RPC/settings definitions, runtime-neutral helpers    | Shared code only       |
| `@getpaseo/plugin/server`                            | Server contribution/handler contexts and lifecycle contracts               | Shared and server code |
| `@getpaseo/plugin/server/provider`, `/server/acp`    | Server provider contracts and adapters                                     | Shared and server code |
| `@getpaseo/plugin/client`                            | Client contribution contexts, hooks, navigation, and UI contribution types | Shared and client code |
| `@getpaseo/plugin/client/react-native`, `/client/ui` | Host-provided UI components                                                | Shared and client code |
| `@getpaseo/plugin/client/host`                       | App-owned rendering integration; not a plugin-author entry                 | Shared and client code |

Server code imports shared helpers from the root and server capabilities from `/server`. Client
code imports shared helpers from the root and client capabilities from `/client`. Neither runtime
imports the other. Re-exports follow the same rule; tree shaking does not establish a boundary.
React, React Native, JSX runtimes, and client hooks must never be reachable from the root or any
server entry. Node and platform-specific code must never be reachable from the shared root.

The SDK boundary checks and real plugin-subprocess tests enforce these rules. Every SDK change
must preserve them and update the public reference, migration guide, scaffold, and examples when
an author-facing import changes. The plugin compiler enforces the same runtime entry rules for
plugin-authored code. Keep the package export map and host-provided module maps consistent.

The compiler rejects imports across runtime directories or SDK entries, React dependencies in
server code, and Node imports in client code (including bare names such as `fs`). Shared modules
cannot import runtime-owned modules. Forbidden imports fail compilation; never replace them with
empty module stubs. A relative
import to any other code file in the plugin root is also rejected; move it into `client/`, `server/`,
or `shared/`. These are compile errors naming the importing file and boundary rule. Top-level React
Native calls such as `StyleSheet.create` belong in `client/`.

The scaffold omits `"DOM"` from `tsconfig.json` and does not use `/// <reference lib="dom" />`, so
browser globals are not available across the plugin. Put sanctioned web-only APIs in
`client/web.ts`, declare only the globals that module uses, gate each export with
`Platform.OS === "web"`, and provide a native implementation or no-op. See the
[public plugin reference](../public-docs/plugins/reference.md#works-on-mobile) for the complete
pattern.

```ts
// index.server.ts
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createGreeting } from "./server/greeting";
import { greetRpc } from "./shared/greeting";

export default function contribute(server: PluginServerContext) {
  server.handle(greetRpc, createGreeting);
  return () => {};
}
```

```tsx
// index.client.tsx
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Greeting } from "./client/greeting";

export default function contribute(client: PluginClientContext) {
  client.addSurface("main", Greeting);
  client.addSidebarItem({ id: "main", title: "Greeting", icon: "MessageCircle", surface: "main" });
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

`usePaseo()` and the handler's `{ paseo }` context expose the same `PaseoApi`: projects,
workspaces, agents, terminals, providers, and daemon config. They do not expose connection lifecycle. A surface borrows the
selected host's existing connection; switching the screen's host changes both `usePaseo()` and
`useRpc()` to that host. An offline selected host fails there and never falls through to another
installation. A server handler owns an IPC-backed daemon session for the life of its subprocess.
Use plugin RPC for plugin-specific backend behavior that is not a normal Paseo operation.

Host-targeted clients and discovery are owned by `packages/app/src/plugins/hosts`, with per-installation
bindings supplied by the bundle loader. Bind the imperative getter to that installation; do not
resolve ownership through a mutable current-plugin global. Keep observation ownership in this module
and transport ownership in the app host runtime. See the [public host API contract](../public-docs/plugins/reference.md#discover-hosts-and-target-another-host).

Each subprocess gets an exclusively owned `plugin:<id>` session. That identity is reserved from
normal clients, never resumes another session, and is cleaned immediately on exit without reconnect
grace. During daemon startup, plugin sessions may connect while application WebSockets remain
paused; the daemon accepts clients only after configured plugins have settled and the initial
catalog is complete.

When the same plugin contribution exists on multiple hosts, Paseo shows it once in the sidebar and
adds a host picker to the screen header. The selected host supplies the bundle, RPC transport, and
query cache. Explicit SDK targets follow the [host API contract](../public-docs/plugins/reference.md#discover-hosts-and-target-another-host).

Workspace panels, Command Center items, and client slash commands are client contributions. The
daemon transports their compiled bundle without interpreting placement or callbacks. Panel props
contain workspace and agent IDs. Required-selector hooks read normalized client state synchronously
and use shallow equality, so a panel does not subscribe to fields it does not render. Command
callbacks materialize their snapshots only when invoked. Contribution discovery and panel opening
never fetch active context through plugin RPC. Snapshot DTOs are deeply readonly and frozen at
runtime so plugin code cannot mutate normalized app state or a memoized selection. Panels use one persisted
`plugin` workspace-tab target, so reload, disable, removal, and restoration resolve through the
current installed-plugin catalog. A missing contribution renders unavailable inside the tab.
Panels declare `locations: ["workspace", "explorer"]` to opt into Explorer hosting; omission means
workspace only. Location controls hosting, not context. An agent panel target keeps its `agentId`
when moved between hosts. Explorer configuration can create workspace-context panels and remove
existing agent-context instances, but it cannot create an agent panel without an agent-aware command.

Command Center callbacks use the selected host's existing `PaseoApi` for normal Paseo operations.
They use typed plugin RPC only for plugin-specific backend work. Surface and panel navigation
belongs to the app; plugins do not receive Expo Router or workspace-layout store access.
See the public [navigation fields](../public-docs/plugins/reference.md#surfaces-and-sidebar-items)
and [external links and workspace browsers](../public-docs/plugins/reference.md#external-links-and-workspace-browsers)
for the author-facing contract. Header buttons and timeline renderers get the same navigation
object from `buildPluginHostNavigation`, the non-hook form: both render from stores, and an overflow
menu builds several plugins' props in one pass, where a hook per entry is not available.

Toasts raised by plugin callbacks go through `packages/app/src/contexts/app-toast.ts`, the app
shell's single toast API. A button `onPress` or slash-command `onSubmit` fires outside React and has
no context to read, so the capability is one implementation rather than a parameter every call site
threads.

Sidebar badges are pushed, not derived. `client.setSidebarBadge` mutates the registered contribution
in place and republishes the registry snapshot — in place because `register` removes contributions
by object identity, so replacing the array entry would leak it.

A Command Center item's `shortcut` becomes a binding appended after the built-ins, so a built-in
always wins a collision and a plugin can never capture keys the app already uses. The binding id is
`plugin:<pluginId>:<itemId>`, which reuses ordinary override storage: rebinding works, but the
shortcut has no row in the shortcuts dialog, whose section order is a static list. Bindings exist
only while the item is contributed — the Command Center registration republishes them from the
contributions it just built (`packages/app/src/plugins/command-center/shortcuts.ts`).
Surface and panel props also expose optional
`openAgentLaunch`, a Host-owned operation that seeds the existing native workspace draft or
`/new` flow with immutable labels and a stable message ID. Its local journal is scoped by host,
plugin, document incarnation, and launch ID; request-start is persisted before daemon effects,
drafts survive app restart, and completed tombstones prevent ordinary replay. Same-key
serialization covers one JavaScript runtime only, not multiple browser tabs or Electron renderers.
The capability's absence is the compatibility gate for older clients. The seed prompt is not proof
of final composer content. The journal lives in `packages/app/src/plugins/agent-launch/`; its
draft binding is the `agentLaunch` record on the draft store (v6). Journal-backed drafts skip the
ordinary `CREATE_FAILED → draft` restore after a request-start. Closing a journal-backed workspace draft
tab before any request-start is the only explicit discard; emptying the composer keeps the draft
active and bound, because the draft store's `abandoned` lifecycle also means "content emptied" and
finalized drafts are pruned. The public contract, including the `no_eligible_workspace`
rejection, is in the reference under "Native agent launch".

## Lifecycle hooks

Server entries register lifecycle observers with `server.on()` and request transforms with
`server.before()`. The [public reference](../public-docs/plugins/reference.md#lifecycle-hooks)
owns callback shapes, ordering, and failure behavior. `plugin-examples/lifecycle-logger` registers all
eleven hooks; `plugin-examples/lifecycle-actions` demonstrates common automation callbacks.

Emit from the operation owner, not a client subscription. Provider history replay must not trigger
live hooks. Observers must not be awaited inside agent mutations: a callback can send a prompt or
answer a permission through its own daemon session. Awaiting it there deadlocks that command.

## Contribute a provider

Register a provider from `index.server.ts`. The provider connection is callback-based and owns all
of its sessions; plugin RPC is not part of the provider data path.

```ts
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { createProvider } from "./server/provider";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createProvider() satisfies ProviderRegistration);
  return () => {};
}
```

Implement optional `ProviderRegistration.getCatalogCacheKey(options)` to share equivalent catalogue
probes. The callback runs in the plugin process before discovery and receives the actual global or
workspace target. Return a key covering effective configuration and execution environment, or
`undefined` for target-specific caching. Ignore `force` when choosing identity. Existing providers
need no change. See [catalogue ownership](providers.md#provider-snapshot-refresh-contract).

`send()` resolves after acceptance. Publish operation completion, prompt disposition, turn state,
configuration, permissions, persistence, and complete timeline snapshots through `onEvent()`.
Route messages, structured commands, steering, and command side effects through `session.prompt`.
Provider settings are toggle/select data that Paseo renders in the composer. Keep private options in
the opaque `providerOptions` config object.

Agent refresh closes the current provider session and opens it again with current configuration and
persistence. Providers re-read credentials, environment, global configuration, and MCP servers on
`session.open`; there is no provider reload input.

For an ACP command, register `runAcpProvider({ id, label, command })` from
`@getpaseo/plugin/server/acp`. Its transformer hooks cover narrow vendor differences; do not translate the
whole provider event stream. The direct and ACP examples live in `plugin-examples/provider-direct`
and `plugin-examples/provider-acp-transformer`.

Provider-emitted plugin timeline items use the same renderer registration as transformed and
daemon-appended plugin items. The direct example includes both sides. The renderer-only
`plugin-examples/inline-thinking` example shows that timeline presentation remains independent of a
provider implementation. The public [provider plugin guide](../public-docs/plugins/providers.md)
owns author workflow, lifecycle, testing, and distribution guidance.

`ProviderRegistration.icon` is a file path relative to the plugin directory, such as `icon.svg`.
It must resolve inside that directory to a regular SVG file no larger than 64 KiB. The SVG must be
self-contained: scripts, styles, `foreignObject`, event-handler attributes, JavaScript URLs, and
external `href` or `xlink:href` references are rejected. Fragment references such as `#mark` are
allowed. Paseo reads and sanitizes the file when the plugin starts; the string is never an inline
SVG or URL.

## Contribute buttons

Header buttons and composer pills share the client-only descriptor and registration lifecycle in
`packages/app/src/plugins/buttons/`. The [public button reference](../public-docs/plugins/reference.md#header-buttons)
owns the author API and placement rules. Keep presentation policy in this module so another
placement can reuse behavior without copying registration or action state.

Native sheets teleport their children. Button surfaces rebuild the installation's SDK, state,
query, and toast providers inside the surface content, including overflow pages from different
plugins. Providers only around the trigger do not reach those bodies.

Request observation with `client.paseo.agents.list({ subscribe: {} })` and consume the returned
`subscription` handle. Plain `list()` and agent/workspace directory `.subscribe(handler)` listeners create no daemon
demand. Provider and project `subscribe()` calls establish their own demand. On capable daemons, each
list-and-subscribe call has its own server ID, even for the same query. Older daemons retain
[shared delivery behavior](protocol-compatibility.md#owned-observations). Handle snapshots
also run after reconnect; replace your view before applying its subsequent updates. The installation
owns every observation created through its API and releases them on unload, including setup failure.
Mounted surfaces and command invocations have shorter API lifetimes.

Keep the client entry synchronous: return its cleanup function immediately and start asynchronous
work inside it. See the maintained [composer pill example](../plugin-examples/local-plugin/client/main.tsx).

A popover's `width` and `sheetTitle: false` apply to the button's own `MenuSurface` only. Overflow
and menu pages share their parent surface's frame, so they keep the page title and width.

## Overlays

`Overlay` (`packages/app/src/plugins/react-native/overlay*.tsx`) is the plugin's own full-window
layer. Plugins used to draw one with React Native's `Modal`; on the web that renders a browser
dialog with its own focus trap, which fought Command Center and host menus for focus until the page
hung. The web overlay registers with `useWebOverlayRegistration` in the shared overlay root instead,
so the [relative layer model](floating-panels.md#gotcha-1--android-touch-hit-test-by-parent-bounds)
decides who gets Escape and focus, and an overlay rendered inside another inherits its layer.

On iOS and Android it stays a native `Modal`: a `@gorhom/portal` host would render the plugin's
children without the providers above them, and the plugin's own contexts cannot be bridged. The
modal window also settles Android Back. Android delivers Back to the topmost modal window, never to
`BackHandler`, so an overlay does not join the sheet back-press chain in
`components/ui/isolated-bottom-sheet-modal/back-press.ts` and needs no listener of its own. The cost
is the one every native modal pays: a host sheet opened from inside an overlay renders in the app
window, under it. Plugins nest another `Overlay` instead of opening `Modal` from one.

`openOverlay` exists because the opener is often on its way out: a popover that closed itself, a
Command Center row, a slash command whose composer just cleared. The store in
`packages/app/src/plugins/overlays/` holds the component and `PluginOverlayHost` mounts it at the
app root under a fresh runtime boundary, since the opener's surface runtime is disposed with it.
Mounting waits a frame, and on iOS the menu engine's teardown grace, for the same reasons
`WorkspaceRenameHost` and `selectItem` wait. An overlay closes when its installation changes, because
its component belongs to the bundle that opened it.

`openImagePreview` follows the same shape with the host's own viewer instead of a plugin
component: `packages/app/src/plugins/image-preview/` keeps the images and the current index, and
`PluginImagePreviewHost` renders `AttachmentLightbox` at the app root. A plugin used to draw its
own preview, which had no zoom and, inside an `Overlay`, no layer of its own. The lightbox is a
native `Modal` and a global web overlay layer, so it lands above whatever the plugin has open,
and Escape or Android Back closes the preview alone. The store holds URIs, not components, so the
preview needs no runtime boundary and survives a plugin reload.

## Contribute timeline items

Timeline transformers and renderers are client contributions. The daemon's canonical rows and
built-in projection stay unchanged. The app transforms each source item while building the render
model, for both fetched history and live events, before native Markdown splitting and Overview
tool grouping. Assistant callbacks receive the accumulated source text, never display fragments.
Live assistant messages use `phase: "streaming"`; committing to history makes them `"complete"`.
Paseo memoizes by source-item reference and phase and derives replacement IDs from source identity, so
streaming updates preserve mounted component identity.

`query.itemType` selects one public `AgentTimelineItem.type`. The callback owns any detailed
recognition and returns plain plugin item objects. `undefined` keeps the source item, `items`
replaces it, and an empty array removes it. Output `data` must be JSON-compatible. Paseo adds the
runtime plugin ID, preserves the source timeline cursor and identity, validates renderer data with
its Zod schema, and mounts the component inside the normal plugin runtime and error boundary. An
optional output `id` distinguishes several stable replacements from the same source item; its output
index is the default.

Transformers run synchronously and must be deterministic. When several transformers match, the
first one that returns a result owns that source item. Plugin and registration ordering is stable.
See `plugin-examples/timeline-items` for the complete contract.

A plugin subprocess can also append a canonical plugin row from a server handler:

```ts
await paseo.agents.ref(agentId).timeline.append({
  type: "plugin",
  id: "review",
  kind: "review-result",
  version: 1,
  data: { status: "ready" },
});
```

The daemon stamps the runtime `pluginId`; plugin code never supplies it. Reusing the same `id`
replaces the previous row from that plugin on live clients and fresh timeline fetches. Rows live in
the daemon's in-memory timeline and survive scroll, refetch, and reconnect, but not a daemon
restart. A row without an installed renderer shows an unavailable placeholder. Serialized `data`
must be at most 64 KiB; the daemon rejects a larger append instead of storing a payload that cannot
be rendered intact. The daemon advertises this RPC through
`server_info.features.pluginTimelineItems`.

## Contribute client slash commands

`addSlashCommand` registers an agent- or workspace-context command in the composer. The
callback runs in the app, receives the trimmed text after the command name as `args`, and receives
the same `paseo`, `rpc`, `openSurface`, workspace, agent, and `openPanel` capabilities as the matching
Command Center callback.

```ts
client.addSlashCommand({
  name: "review",
  description: "Run the review bot",
  argumentHint: "[scope]",
  context: "agent",
  async onSubmit({ args, agent, rpc }) {
    await rpc(startReview, { agentId: agent.id, scope: args });
  },
});
```

Paseo owns the autocomplete row, input clearing, and error toast. It never sends the command text to
the agent. Built-in client commands win name and alias collisions, plugin commands win
provider-command collisions, and the first plugin in stable catalog order wins collisions between
plugins. Plugin slash commands do not run when the composer has attachments.

## Contribute a Git Forge

A Forge plugin registers the same provider ID from separate runtime entries. Keep the provider
definition under `shared/` so the client and server cannot drift:

```ts
// index.server.ts
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { acmeServerProvider } from "./server/acme";

export default function contribute(server: PluginServerContext) {
  server.addForgeServerProvider(acmeServerProvider);
  return () => {};
}
```

```ts
// index.client.ts
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { acmeClientProvider } from "./client/acme";

export default function contribute(client: PluginClientContext) {
  client.addForgeClientProvider(acmeClientProvider);
  return () => {};
}
```

The server provider implements `PluginForgeServerService`. It owns authentication, API/CLI calls,
search, status, checks, timeline, create/merge commands, and change-request checkout targets. Use
the exported `ForgeCliMissingError`, `ForgeAuthenticationError`, and `ForgeCommandError` classes so
the daemon preserves setup and auth failure states across the subprocess boundary. If
`isAuthenticated()` throws those classified errors, set `authProbeCanThrow: true`; otherwise return
`false` on authentication failure. Return explicit `checkoutRefs` for cross-repository heads. Set
`supportsCrossRepoCheckoutWithoutRefs: true` only when the forge exposes a universal fetch ref that
does not need those entries. Take the CLI plumbing from
`@getpaseo/plugin/server/forge-toolkit` rather than writing it again — see
[the plugin toolkit](forge-providers.md#the-plugin-toolkit).

A forge with no CLI sets `signIn: null` and names a `setup` screen instead: the PR pane's setup
callout then opens that screen rather than telling the user to "set up" the forge with no further
detail. Paseo fills in the owning plugin, so a provider cannot point setup at another plugin's
screen.

The client provider contributes the shared definition plus optional facts parsing, merge-capability
derivation, source URL grammar, a declarative SVG path, and brand colors. Client contributions are
scoped to the daemon that supplied the plugin catalog. Do not put them in a process-global Forge
map; one app can connect to hosts with different installed providers.

Provider IDs and facts families match `^[a-z0-9][a-z0-9._-]*$`. They cannot replace an existing
registration on the same host, and built-in Forge IDs are reserved. `cloudHosts` is the bounded list
of public hosts. Use `probeHost` only for a self-hosted forge that can recognize a host through
existing local authentication without sending credentials or anonymous requests to a
remote-derived host.

Reload, disable, removal, subprocess failure, and the global plugin switch unregister the server
adapter and client contribution. Registry changes stop active status polls, discard cached adapter
resolution, and refresh affected workspaces. Async `invalidate`, `defaultCheckoutRefs`, and
`buildPrLocalBranchName` calls finish through the subprocess proxy before the next dependent read.

The generic Forge architecture and the built-in path are documented in
[forge-providers.md](forge-providers.md).

## Contribute composer attachments

Register a declarative attachment source backed by a plugin RPC. Paseo owns the attachment menu,
search picker, drafts, selected pill, and submission. The plugin returns complete text snapshots;
credentials and vendor API calls stay in the daemon handler.

```ts
// index.server.ts
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { search } from "./server/issues";
import { searchIssues } from "./shared/issues";

export default function contribute(server: PluginServerContext) {
  server.handle(searchIssues, search);
  return () => {};
}
```

```tsx
// index.client.tsx
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { issues } from "./shared/issues";

export default function contribute(client: PluginClientContext) {
  client.addAttachmentSource(issues);
  return () => {};
}
```

Attachment sources stay scoped to the composer's host. Unlike sidebar contributions, equal sources
on several hosts are not coalesced. The selected snapshot submits as a text attachment with neutral
external-resource presentation, so it remains readable if the plugin is removed or an older peer
drops the optional presentation fields.

## Contribute settings

Register ordinary components with `client.addSettingsScreen` and open them with `openSettings`.
The host settings shell owns navigation and layout; plugin content must not add another page
scroll view or header. See the [author contract](../public-docs/plugins/reference.md#settings-screens)
and `plugin-examples/settings` for the named UI components and persistence API.

Settings storage is scoped to the runtime installation ID, never the source path or manifest ID.
Its writer lives with the plugin subprocess, while its directory lives outside managed sources,
so updates and reloads retain values. Settings-change notifications must not enter the catalog
reload path: that path disposes the plugin and would destroy open drafts after every save.

`server.registerSettings(definition)` returns a server-side handle for the same document. Use
`read()` for the current `ready` or `invalid` state (invalid states carry a stable `code`),
`subscribe()` for successful saves, resets, migrations, and server updates, and `update(mutator)` for
a serialized read-modify-write. Mutators are synchronous, receive a deeply frozen detached value, and
return `commit` or `unchanged`. Server updates, client CAS writes, reset, and migration share one
installation queue and one atomic file, and every commit notifies subscribers and clients once.
Reentry, thenables, invalid values, and mutator throws do not write; only watchdog poisoning blocks
later access until plugin reload. The subscription cleanup belongs in the plugin's contribution
cleanup when it outlives the entry. `server.paseo` is the already-connected owner-authority daemon
SDK and is available during contribution startup as well as handlers and lifecycle callbacks.

## Keep secrets on the daemon

**Never put an API token in a settings document.** `settings.<id>.read` is an ordinary RPC and the
id is derivable from the plugin, so any connected client can fetch that document — the token would
reach every phone attached to the daemon, and it is cached there.

`server.secrets` stores values that never leave the daemon host: `get`, `has`, `keys`, `set`,
`delete`, keyed by `^[a-z0-9][a-z0-9._-]*$`. It writes `_secrets.json` beside the settings documents
with owner-only permissions and publishes no RPC handler at all. The leading underscore matters: a
settings id must start with a letter, so a plugin's `secrets` settings document, which any client can
overwrite or reset, can never share that file.

Give the user a UI by pairing it with your own RPCs — one that only accepts a value, one that only
reports whether a value exists:

```ts
server.handle(setTokenRpc, async ({ token }) => {
  await server.secrets.set("api-token", token);
  return { ok: true };
});
server.handle(tokenStatusRpc, async () => ({ configured: await server.secrets.has("api-token") }));
```

Settings then hold only the non-secret half: base URL, self-hosted host, which account to use.

## Read client presence

`server.presence()` travels over the plugin process IPC channel (`presence.request` /
`presence.result`), not the WebSocket session protocol. Presence is per-client heartbeat state held
by `VoiceAssistantWebSocketServer`; putting it on the session protocol would let any connected client
read what the others are doing. The runtime answers before `ready`, so a contribution can read it
during startup. `userPresent` comes from `isClientPresent` in
`packages/server/src/server/agent-attention-policy.ts`, the predicate that also holds back push
notifications; change the rule there and both follow.

## Contribute a theme

`addTheme` takes a small light or dark palette and a display name. Paseo expands it through the
same semantic builders as the built-in themes, so plugins do not depend on the complete app token
contract. Unistyles needs every theme name at `StyleSheet.configure` time, so
`packages/app/src/styles/theme.ts` reserves one light and one dark plugin slot. The appearance
provider rewrites the matching slot when the selection changes. See [unistyles.md](unistyles.md)
for the runtime-patching rules the appearance settings share.

`addTheme` is a client registration and belongs in `index.client.tsx`. A client that predates it
cannot evaluate that entry. Daemons advertise
`features.pluginThemes` in `server_info`; the plugin theme catalog is the one place the app reads it, and
a host without it contributes no themes.

The selection persists as `theme: "plugin"` plus a `pluginThemeId` of `<pluginId>/theme/<themeId>`,
so equal themes on several hosts coalesce the way sidebar contributions do. Two hosts can answer
that id with different palettes, so picking a theme records its host through
`rememberPluginContributionHost` and resolution prefers it; a peer connecting or dropping then does
not repaint the app. Without a preference the sorted registry snapshot decides, so the result is
stable rather than arrival-ordered. The app resolves that id
against the installed catalog on every change; an id nothing contributes falls back to the default
preference instead of painting the reserved slot's placeholder colors.

Existing plugin authors should follow the standalone [v0.8 runtime-entry migration guide](../public-docs/plugins/migration.md).

See `plugin-examples/local-plugin` for a native surface, `plugin-examples/linear` for a complete
attachment-source example, `plugin-examples/timeline-items` for timeline projection, and
`plugin-examples/catppuccin` for a theme.
