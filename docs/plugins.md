# Plugins

Local plugins contribute daemon RPCs, native app surfaces, workspace panels, Command Center items,
client slash commands, timeline items, composer pills, app themes, composer attachment sources, and settings screens.
Paseo executes `index.server.ts` in a subprocess and `index.client.tsx` in every connected app.

> **Trust every plugin you add.** `paseo plugin add` and `paseo plugin install` mean “I trust this codebase.” Plugins are unsandboxed: server code and Git preparation commands run with the daemon user's access on the daemon host, and client contributions run inside Paseo. The repository's dependencies and future updates are part of that trust decision. With `--host`, preparation runs on that remote daemon host.

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
[requirements contract](../public-docs/plugins/v0.8/reference.md#requirements), including legacy
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

Omitting `--ref` tracks the remote's default branch. A branch passed with `--ref` also tracks;
tags and commits stay pinned. `ls` reports the installed commit without contacting the remote.
Removing a Git source deletes Paseo's managed checkout.

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
`<Modal.Content>`. Body layout, sheet-aware scrolling, and clipboard actions follow the
[host UI contract](../public-docs/plugins/v0.8/reference.md#host-ui).
Plugin UI runs on desktop and mobile across multiple themes: color every `Text` from
`theme.colors.foreground` or `theme.colors.foregroundMuted`, and size layout from `layout.compact`.
See `public-docs/plugins/v0.8/reference.md`.

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
[public plugin reference](../public-docs/plugins/v0.8/reference.md#works-on-mobile) for the complete
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

Each subprocess gets an exclusively owned `plugin:<id>` session. That identity is reserved from
normal clients, never resumes another session, and is cleaned immediately on exit without reconnect
grace. During daemon startup, plugin sessions may connect while application WebSockets remain
paused; the daemon accepts clients only after configured plugins have settled and the initial
catalog is complete.

When the same plugin contribution exists on multiple hosts, Paseo shows it once in the sidebar and
adds a host picker to the screen header. The selected host supplies the bundle, RPC transport, and
query cache. Plugin code cannot address another host.

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
They use typed plugin RPC only for plugin-specific backend work. Surface and panel props expose
optional client-owned agent and workspace navigation; its absence is the compatibility gate for
older clients. Other navigation remains limited to registered global surfaces and workspace panels.
Plugins do not receive Expo Router or workspace-layout store access.

## Lifecycle hooks

Server entries register lifecycle observers with `server.on()` and request transforms with
`server.before()`. The [public reference](../public-docs/plugins/v0.8/reference.md#lifecycle-hooks)
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
provider implementation. The public [provider plugin guide](../public-docs/plugins/v0.8/providers.md)
owns author workflow, lifecycle, testing, and distribution guidance.

`ProviderRegistration.icon` is a file path relative to the plugin directory, such as `icon.svg`.
It must resolve inside that directory to a regular SVG file no larger than 64 KiB. The SVG must be
self-contained: scripts, styles, `foreignObject`, event-handler attributes, JavaScript URLs, and
external `href` or `xlink:href` references are rejected. Fragment references such as `#mark` are
allowed. Paseo reads and sanitizes the file when the plugin starts; the string is never an inline
SVG or URL.

## Contribute composer pills

Add and remove targeted pills from the client entry lifecycle. `index.client.tsx` runs once per
plugin installation in each connected app and never runs in the daemon subprocess. It can subscribe
to the client API, call plugin RPCs, and own arbitrary client state without mounting a panel or
surface.

```tsx
export function contributeClient(client: PluginClientContext) {
  const pills = new Map<string, () => void>();
  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (update.kind !== "upsert" || !update.agent.workspaceId) return;
    const { id: agentId, workspaceId } = update.agent;
    pills.get(agentId)?.();
    pills.set(
      agentId,
      client.addComposerPill({
        id: "review",
        title: "Open review",
        workspaceId,
        agentId,
        Component: ReviewPill,
        async onPress() {
          await client.rpc(refreshReview, { agentId });
          client.openPanel("review", { workspaceId, agentId });
        },
      }),
    );
  });
  return () => {
    unsubscribe();
    for (const remove of pills.values()) remove();
  };
}
```

Call `contributeClient(client)` from `index.client.tsx`, or move its body into that entry.
`addComposerPill` returns an idempotent removal function. A pill appears only in the
matching workspace and agent track bar alongside Tasks and Subagents. Paseo owns the pressable,
shared chrome, pending state, error reporting, and placement. The component owns its icon and text;
the callback is client code by construction. Removing the pill, reloading the plugin, disconnecting
the host, or unloading the app tears down the contribution.

## Contribute timeline items

Timeline transformers and renderers are client contributions. The daemon's canonical rows and
built-in projection stay unchanged. The app transforms each source item while building the render
model, for both fetched history and live events. The input includes `phase: "streaming" | "complete"`.
Paseo memoizes by source-item reference and derives every replacement ID from the source identity, so
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
scroll view or header. See the [author contract](../public-docs/plugins/v0.8/reference.md#settings-screens)
and `plugin-examples/settings` for the named UI components and persistence API.

Settings storage is scoped to the runtime installation ID, never the source path or manifest ID.
Its writer lives with the plugin subprocess, while its directory lives outside managed sources,
so updates and reloads retain values. Settings-change notifications must not enter the catalog
reload path: that path disposes the plugin and would destroy open drafts after every save.

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

Existing plugin authors should follow the standalone [v0.8 runtime-entry migration guide](../public-docs/plugins/v0.8/migration.md).

See `plugin-examples/local-plugin` for a native surface, `plugin-examples/linear` for a complete
attachment-source example, `plugin-examples/timeline-items` for timeline projection, and
`plugin-examples/catppuccin` for a theme.
