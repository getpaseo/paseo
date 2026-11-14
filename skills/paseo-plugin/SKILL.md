---
name: paseo-plugin
description: Build and manage trusted local Paseo plugins. Use when the user asks to create, edit, install, reload, enable, disable, remove, or troubleshoot a Paseo plugin; add lifecycle hooks; transform agent configuration, environment, MCP servers, or workspace creation; automate permissions or turn follow-ups; add a screen, sidebar header or footer item, workspace panel, or file panel; add Command Center items or slash commands; add composer pills or attachment sources; transform, render, or append agent timeline items; contribute a theme; use Paseo from plugin code; or add plugin RPCs.
---

# Paseo plugins

Build or manage the requested plugin directly. Use the current public docs to catch contract changes, but keep working from this skill if the network is unavailable.

Use the user's request and current conversation as input, including any arguments supplied with the skill invocation.

## Check current documentation

Fetch [https://paseo.sh/llms.txt](https://paseo.sh/llms.txt) first. Select and fetch the current plugin Markdown pages from that index before changing a plugin:

- [Plugin quickstart](https://paseo.sh/docs/plugins.md) ([browser page](https://paseo.sh/docs/plugins))
- [Publishing](https://paseo.sh/docs/plugins/publishing.md): npm package contents, dependencies, Git preparation, and private registries.
- [Plugin reference](https://paseo.sh/docs/plugins/reference.md) ([browser page](https://paseo.sh/docs/plugins/reference))

Use the deployed docs when they disagree with this skill. Do not send the user away to read them instead of completing the work.

In the Paseo repository, use `public-docs/plugins/reference.md` for the checkout's API, including
unreleased changes. Use `docs/plugins.md` for maintainer guidance. Complete contracts belong in the
public docs; this skill indexes the references and examples.

## Choose the guidance for this task

Read only the references needed for the requested change. Combine them when a plugin spans
contribution types; do not load every example by default. The shared setup, runtime boundaries,
mobile constraints, trust checks, and verification below apply to every task.

| Task                                                                                                          | Read when needed                                                                         |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Choose an extension point, find lifecycle examples, or add a file panel, Command Center item, or subscription | [Contribution catalog](references/contributions.md), then its linked contract or example |
| Add a workspace tab or Explorer panel with `addWorkspacePanel`                                                | [Workspace panel](references/workspace-panel.md)                                         |
| Add a screen and sidebar header or footer item                                                                | [Screen and sidebar](references/screen-sidebar.md)                                       |
| Call the Paseo SDK, add plugin RPCs, contribute session tools/MCP servers, or debug daemon behavior           | [API and daemon behavior](references/api.md)                                             |
| Add a searchable composer attachment source                                                                   | [Attachment source](references/attachment-source.md)                                     |
| Add a client `/command` with `addSlashCommand`                                                                | [Slash command](references/slash-command.md)                                             |
| Add a per-agent composer button with `addComposerPill`                                                        | [Composer pill](references/composer-pill.md)                                             |
| Transform/render timeline items or append a row from the daemon                                               | [Timeline](references/timeline.md)                                                       |
| Add a light or dark palette with `addTheme`                                                                   | [Theme](references/theme.md)                                                             |
| Prepare a registry listing and `OVERVIEW.md`                                                                  | [Publishing](references/publishing.md)                                                   |

Use the existing Paseo SDK for normal Paseo operations. Use plugin RPC only for plugin-specific
backend behavior. Keep credentials, filesystem access, shell commands, and vendor API calls in
daemon handlers. Use TanStack Query for async request state, caching, and mutations.

## Create the project

Use an absolute path on the daemon machine. `init` writes files but does not install packages.

```bash
paseo plugin init /absolute/path/to/my-plugin
cd /absolute/path/to/my-plugin
npm install
```

The generated project contains:

```text
my-plugin/
  paseo-plugin.json
  OVERVIEW.md
  package.json
  tsconfig.json
  index.client.tsx
  index.server.ts
  client/greeting.tsx
  server/greeting.ts
  shared/greeting.ts
```

The manifest supplies the default install ID and supported Paseo versions:

```json
{ "id": "my-plugin", "requirements": { "paseo": ">=0.8.0" } }
```

Keep `requirements.paseo` correct whenever creating or editing a plugin. `init` uses `>=` followed
by the CLI version. Raise the minimum when adopting newer APIs; add an upper bound when a later
Paseo release is incompatible. Use npm semver ranges and explicitly include beta versions when
targeting betas. Missing requirements mean `<0.8.0`; complete the 0.8 entry migration before adding
`>=0.8.0`. Verify compatibility with both the daemon and the app running client contributions.
See [requirements](https://paseo.sh/docs/plugins/reference#requirements).

Each runtime has its own optional entry. A plugin must have at least one. Both entries accept
`.ts` or `.tsx`; use `.tsx` when an entry imports components.

| Path                             | Runtime           |
| -------------------------------- | ----------------- |
| `index.client.tsx` and `client/` | App               |
| `index.server.ts` and `server/`  | Daemon subprocess |
| `shared/`                        | Both              |

Do not put any other code modules in the plugin root.

A client import of `server/`, a server import of `client/`, and every `node:` import reachable from
client code is a compile error. A relative import to another code file in the plugin root is also a
compile error; move it into `client/`, `server/`, or `shared/`. Shared modules contain Zod contracts
and plain values; they do not import Node or React Native runtime APIs.

Default-export one contribution function from each entry and return cleanup:

```tsx
// index.client.tsx
import type { PluginClientContext } from "@getpaseo/plugin/client";

export default function contribute(client: PluginClientContext) {
  // Register components and client callbacks here.
  return () => {};
}
```

```ts
// index.server.ts
import type { PluginServerContext } from "@getpaseo/plugin/server";

export default function contribute(server: PluginServerContext) {
  // Register daemon-side RPC handlers here.
  return () => {};
}
```

Cleanup can be async. Use it for timers, watchers, sockets, subscriptions, and other resources
created by plugin code. Every client `add*` method returns an idempotent remover. Paseo calls the
entry cleanup first, removes registrations that remain, rejects pending RPCs, closes the plugin
session, and stops the subprocess when the plugin stops.

## Works on mobile

Before reporting a plugin done:

- Use React Native primitives only: `View`, `Text`, `Pressable`, `ScrollView`, and `TextInput`.
- Do not use HTML elements, `className`, CSS strings, or `onClick`.
- Do not put `"DOM"` in `tsconfig.json` or use `/// <reference lib="dom" />`. Put DOM globals only in
  `client/web.ts`, declare only what that module uses, gate every export on `Platform.OS === "web"`,
  and provide the native alternative or a no-op.
- Take colors from `theme.colors`.
- Check the compact layout.

Run this audit on `client/`:

```bash
rg -n "document\.|window\.|localStorage|navigator\.|<[a-z]+[ >]|className=|onClick=" client/
```

A hit outside `client/web.ts` is a bug.

## Hosts and trust

Plugins are installed per daemon and are trusted, unsandboxed code. Backend code can access files, processes, credentials, and network services on the daemon machine. Client contributions run inside the Paseo app. Do not install a plugin the user has not authorized or source code you have not inspected.

### Check the global switch before installing

Identify the target daemon and inspect its root `pluginsEnabled` value in `config.json`. For the local daemon, `paseo daemon status --json` reports its `home`; the file is `<home>/config.json`. Treat a missing field as `false`. Do not infer the global value from a plugin's `disabled` status, because an individual plugin can also be disabled.

If `pluginsEnabled` is already `true`, continue without asking the user to enable it.

If it is false or absent, stop and ask the user for explicit permission before editing or enabling anything. Include this warning in the request:

> Plugins are trusted, unsandboxed code. Backend plugin code can access your daemon machine, including files, processes, credentials, and network services. Client plugin code runs inside the Paseo app. May I enable plugins on this daemon?

Do not continue unless the user agrees. After permission:

1. Preserve the rest of `config.json` and set the root `pluginsEnabled` field to `true`.
2. Run `paseo reload --json` against that daemon.
3. Require `pluginsEnabled` in `appliedPaths`, or accept an empty `appliedPaths` only after re-reading the file and confirming the live plugin catalog is enabled.
4. Run `paseo plugin ls` and verify the intended plugin reaches `running` after installation.

If the user asks to disable the global switch, set `pluginsEnabled` to `false`, run `paseo reload --json`, and verify configured plugins report `disabled`.

Do not edit a local config when the target is a remote daemon. Perform the edit on the daemon machine, or ask the user to use **Settings → Plugins → Enable plugins**. `paseo reload --host <url>` reloads the remote daemon's own file but does not edit it.

When the same screen or sidebar item exists on several connected hosts, Paseo shows it once. The screen header has a host picker; a sidebar item uses the host of the screen on display, else the host last picked in one of the plugin's screens. The selected host owns the bundle, SDK calls, RPCs, and query cache. An offline selected host does not fall through to another host. Attachment sources stay scoped to the composer's host.

## Typecheck and manage

When editing a plugin, typecheck its source before install or reload:

```bash
npm run typecheck
paseo plugin install /absolute/path/to/plugin
paseo plugin install /absolute/path/to/plugin --id another-runtime-id
paseo plugin install npm:@acme/paseo-review
paseo plugin install npm:@acme/paseo-review@1.2.0
paseo plugin install github:owner/repository
paseo plugin install github:owner/repository --ref main
paseo plugin update my-plugin
paseo plugin ls
paseo plugin reload my-plugin
paseo plugin logs my-plugin
paseo plugin disable my-plugin
paseo plugin enable my-plugin
paseo plugin remove my-plugin
```

For npm, ensure npm is on the daemon's `PATH`; use that host's registry configuration and credentials. Install selectors choose
content once; they do not pin updates. `install` and `add` are aliases. Follow the
[publishing guide](https://paseo.sh/docs/plugins/publishing.md) for Paseo's package contents and
preparation requirements; standard npm publishing commands apply.

Use `--host <url>` when managing a daemon other than the CLI default. A Git source that must install or generate something declares `build` in `paseo-plugin.json` as a list of argv arrays; Paseo runs them without a shell on install and update and keeps the old version if one fails. Plugin source edits require `paseo plugin reload`; config changes to the global switch require `paseo reload`. A failed plugin reload stays failed; inspect `paseo plugin ls` for the load error and `paseo plugin logs <id>` for subprocess output, fix the source, typecheck, and reload again. `remove` keeps local source directories and deletes managed Git/npm installations.

Do not restart the daemon to load source changes. Restarting it can kill the agent performing the work.

For an old mixed entry, follow the standalone [runtime-entry migration guide](https://paseo.sh/docs/plugins/migration) mechanically.

## Verify the outcome

After a change:

1. Run `npm run typecheck`.
2. Install or reload the exact runtime ID.
3. Run `paseo plugin ls` and require `running` with no error.
4. Confirm the contribution on the intended host. Open the Command Center with **⌘K** (macOS) or **Ctrl+K** (Windows/Linux). Type `/` in the composer for slash commands. For timeline work, run an agent turn that produces the source item and watch it while it streams, not only after it completes. For UI work, check a wide desktop window and a compact/mobile client, and switch theme to confirm text still uses `foreground` / `foregroundMuted`.
5. Exercise the changed action or RPC, including its error state.

Common failures:

- Missing sidebar item: wrong host, plugin not `running`, the item is hidden in Settings > Sidebar, or its component throws (a `SidebarRow` with an unknown Lucide name or unsafe SVG throws).
- Unavailable client module: client bundles can use only the host-provided modules listed above.
- RPC rejection: input or output failed its Zod schema, or the handler threw. Inspect `paseo plugin logs <id>` for handler output.
- Plugin exits or reload fails: inspect `paseo plugin ls` for status and `paseo plugin logs <id>` for initialization, cleanup, or crash output.
- Stale UI: source was edited without `paseo plugin reload <id>`.
- Timeline item shows "Plugin timeline item unavailable": no renderer registered for that `kind` and `version`, the renderer schema rejected `data`, or the plugin is not running on that host.
- Transformer has no effect: `query.itemType` does not match the source type, the transform returned `undefined`, or it threw and was skipped; check the app console for `[Plugins] Timeline transformer failed`.
- Slash command not offered: name collides with a built-in or another plugin, the context is `agent` on a draft, or the composer has attachments.
- Append rejected: the caller is not a plugin session, `data` exceeds 64 KiB, or the host predates `features.pluginTimelineItems`.
