---
name: paseo-plugin
description: Build and manage trusted local Paseo plugins. Use when the user asks to create, edit, install, reload, enable, disable, remove, or troubleshoot a Paseo plugin; add a native surface, sidebar item, or workspace panel; add Command Center items or slash commands; add composer pills or attachment sources; transform, render, or append agent timeline items; contribute a theme; use Paseo from plugin code; or add plugin RPCs.
---

# Paseo plugins

Build or manage the requested plugin directly. Use the current public docs to catch contract changes, but keep working from this skill if the network is unavailable.

**User's request:** $ARGUMENTS

## Check current documentation

Fetch [https://paseo.sh/llms.txt](https://paseo.sh/llms.txt) first. Select and fetch the current plugin Markdown pages from that index before changing a plugin:

- [Plugin quickstart](https://paseo.sh/docs/plugins.md) ([browser page](https://paseo.sh/docs/plugins))
- [Plugin reference](https://paseo.sh/docs/plugins/v0.8/reference.md) ([browser page](https://paseo.sh/docs/plugins/v0.8/reference))

Use the deployed docs when they disagree with this skill. Do not send the user away to read them instead of completing the work.

When working in the Paseo repository, also read `docs/plugins.md` and the relevant example under `plugin-examples/`.

## What a plugin can contribute

Pick the contribution that matches the request. Each row names the registration, when it fits, and where the full contract lives. Most plugins combine several: a slash command that calls an RPC, which appends a timeline row, which a renderer draws.

| Contribution         | Registration                                     | Use it when                                                                                                   | Reference                                                                                          |
| -------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Sidebar surface      | `addSurface` + `addSidebarItem`                  | A full screen of plugin UI reachable from the sidebar                                                         | reference.md → Surfaces and sidebar items; `plugin-examples/local-plugin`                          |
| Workspace panel      | `addWorkspacePanel`                              | UI that lives as a tab beside agents, terminals, files, and diffs; `locations: ["explorer"]` for the Explorer | reference.md → Workspace panels                                                                    |
| Command Center item  | `addCommandCenterItem`                           | A global, workspace, or agent action reachable from ⌘K                                                        | reference.md → Command Center items                                                                |
| Client slash command | `addSlashCommand`                                | A `/command args` in the composer that runs plugin code instead of prompting the agent                        | reference.md → Client slash commands                                                               |
| Composer pill        | `addComposerPill`                                | A per-agent button in the composer track bar next to Tasks and Subagents                                      | reference.md → Composer pills                                                                      |
| Timeline transformer | `addTimelineTransformer` + `addTimelineRenderer` | Replace, explode, or hide a built-in timeline item, including while it streams                                | reference.md → Timeline items; `plugin-examples/timeline-items`, `plugin-examples/inline-thinking` |
| Timeline row         | `paseo.agents.ref(id).timeline.append(...)`      | Push a plugin-owned row into an agent timeline from a server handler and update it later                      | reference.md → Append a timeline row from the daemon                                               |
| Attachment source    | `client.addAttachmentSource` + `server.handle`   | Let the user attach a searchable external resource, such as an issue, to a prompt                             | reference.md → Add a composer attachment source; `plugin-examples/linear`                          |
| Theme                | `addTheme`                                       | A light or dark palette under Settings → Appearance                                                           | reference.md → Contribute a theme; `plugin-examples/catppuccin`                                    |
| Plugin RPC           | `defineRpc` + `server.handle` + `useRpc`         | Daemon-side work that is not a normal Paseo operation: vendor APIs, credentials, local files                  | reference.md → Add plugin-specific backend behavior                                                |
| Paseo SDK            | `usePaseo()` / handler `{ paseo }`               | Normal Paseo operations: workspaces, agents, providers, config                                                | reference.md → Use the Paseo SDK                                                                   |

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
See [requirements](https://paseo.sh/docs/plugins/v0.8/reference#requirements).

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
import type { PluginClientContext } from "@getpaseo/plugin";

export default function contribute(client: PluginClientContext) {
  // Register components and client callbacks here.
  return () => {};
}
```

```ts
// index.server.ts
import type { PluginServerContext } from "@getpaseo/plugin";

export default function contribute(server: PluginServerContext) {
  // Register daemon-side RPC handlers here.
  return () => {};
}
```

Cleanup can be async. Use it for timers, watchers, sockets, subscriptions, and other resources
created by plugin code. Every client `add*` method returns an idempotent remover. Paseo calls the
entry cleanup first, removes registrations that remain, rejects pending RPCs, closes the plugin
session, and stops the subprocess when the plugin stops.

## Add a workspace panel

Workspace panels live beside agents, terminals, files, and diffs. Plugins run on desktop and
mobile, and Paseo has multiple themes. Every `Text` must take its color from `theme.colors`.
Use `layout.compact` for padding and stacking. Unstyled text is black and fails in dark themes.

```tsx
import {
  type PluginClientContext,
  type PluginWorkspacePanelProps,
  useWorkspace,
} from "@getpaseo/plugin";
import { useMemo } from "react";
import { Text, View } from "react-native";

function Overview({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const name = useWorkspace(workspaceId, (workspace) => workspace.name);
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        gap: layout.compact ? 8 : 12,
        backgroundColor: theme.colors.surface0,
      },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24 },
    }),
    [theme, layout.compact],
  );
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{name}</Text>
    </View>
  );
}

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "overview",
    title: "Workspace overview",
    icon: "PanelsTopLeft",
    context: "workspace",
    Component: Overview,
  });
  client.addCommandCenterItem({
    id: "open-overview",
    title: "Open workspace overview",
    icon: "PanelsTopLeft",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("overview");
    },
  });
  return () => {};
}
```

Use `useWorkspace(id, selector)` and `useAgent(id, selector)`. Selectors are required
and their results use shallow equality. Never select the whole snapshot or add an RPC to discover
the active workspace or agent. Command callbacks receive the selected host's `paseo`, typed
`rpc(contract, input)`, `openSurface(id)`, and contextual `openPanel(id)` capabilities.

## Add a sidebar surface

Plugin surfaces use React Native primitives and work across desktop, browser, iOS, and Android. Register the surface before its sidebar item. Color text from `theme.colors` and pad from `layout.compact`.

```tsx
import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

function Counter({ theme, layout }: PluginSurfaceProps) {
  const [count, setCount] = useState(0);
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        gap: 16,
        backgroundColor: theme.colors.surface0,
      },
      count: { color: theme.colors.foreground, fontSize: layout.compact ? 36 : 48 },
      button: { padding: 14, borderRadius: 10, backgroundColor: theme.colors.accent },
      buttonText: { color: theme.colors.accentForeground, textAlign: "center" as const },
    }),
    [theme, layout.compact],
  );
  return (
    <View style={styles.screen}>
      <Text style={styles.count}>{count}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Increment counter, currently ${count}`}
        onPress={() => setCount((value) => value + 1)}
        style={styles.button}
      >
        <Text style={styles.buttonText}>Count me in</Text>
      </Pressable>
    </View>
  );
}

export default function contribute(client: PluginClientContext) {
  client.addSurface("main", Counter);
  client.addSidebarItem({
    id: "main",
    title: "Counter",
    icon: "ListPlus",
    surface: "main",
  });
  return () => {};
}
```

Icons are Lucide icon names. `theme` is a typed `PluginTheme` on every surface and panel. Primary text uses `theme.colors.foreground`; labels use `theme.colors.foregroundMuted`; the root view uses `theme.colors.surface0`. `layout.compact` is true on mobile and narrow windows. Paseo owns the route, header, host picker, close action, error boundary, and per-installation query client.

Client code may import `react`, `react-native`, `@tanstack/react-query`, `zod`, `@getpaseo/plugin`, and `@getpaseo/plugin/react-native`. Install dependencies locally for typechecking; Paseo supplies these runtime modules. JSX compiles with the automatic runtime, so no `React` import is needed for JSX. Importing a `node:` module from client code is a compile error.

| Module                          | Use it for                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `@getpaseo/plugin`              | contribution contracts, shared definitions, RPC input/output types, `usePaseo`, `useRpc`, and data hooks |
| `@getpaseo/plugin/react-native` | Paseo UI: `Icon`, `Modal`, `useToast`, `useRevealedText`                                                 |
| `@getpaseo/plugin/server`       | handler-only types such as `PluginHandlerContext`                                                        |

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

## Choose the correct API

Use the existing Paseo SDK for normal Paseo operations. Use plugin RPC only for plugin-specific backend behavior.

### Call Paseo from a surface

`usePaseo()` borrows the selected host's current connection. Never create another client inside a surface.

```tsx
import { usePaseo } from "@getpaseo/plugin";

function PullRequestAction() {
  const paseo = usePaseo();

  async function createReviewWorkspace() {
    const workspace = await paseo.workspaces.create({
      title: "Review PR 42",
      source: {
        kind: "worktree",
        cwd: "/absolute/path/to/repository",
        action: "checkout",
        checkoutSource: { kind: "change_request", forge: "github", number: 42 },
      },
    });
    await workspace.agents.create({
      config: { provider: "codex/gpt-5.5" },
      prompt: "Review PR #42.",
    });
  }

  // Wire createReviewWorkspace to a Pressable.
  return null;
}
```

The API covers workspaces, agents, providers, and daemon config. It omits connection lifecycle because Paseo owns the connection. Consult the current [SDK reference](https://paseo.sh/docs/sdk/reference.md) for method details.

### Add daemon-side behavior

Define one Zod contract in `shared/`, register its subprocess handler in `index.server.ts`, and
call it from client code with `useRpc()`:

```ts
// shared/greeting.ts
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const greeting = defineRpc({
  name: "greeting.create",
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string() }),
});
```

```ts
// server/greeting.ts
import type { RpcInput } from "@getpaseo/plugin";
import { greeting } from "../shared/greeting";

export async function createGreeting({ name }: RpcInput<typeof greeting>) {
  return { message: `Hello, ${name}!` };
}
```

```ts
// index.server.ts
import type { PluginServerContext } from "@getpaseo/plugin";
import { createGreeting } from "./server/greeting";
import { greeting } from "./shared/greeting";

export default function contribute(server: PluginServerContext) {
  server.handle(greeting, createGreeting);
  return () => {};
}
```

```tsx
// client/greeting.tsx
import { useRpc } from "@getpaseo/plugin";
import { greeting } from "../shared/greeting";

function Greeting() {
  const createGreeting = useRpc(greeting);
  // Use createGreeting({ name: "Ada" }) in a query, mutation, or event.
  return null;
}
```

Inputs and outputs are validated on both sides. Backend handlers receive the same `PaseoApi` as `{ paseo }`; their IPC-backed daemon session lives exactly as long as the subprocess. Backend code can use Node APIs and installed dependencies. Keep credentials, filesystem access, shell commands, and vendor API calls in the handler rather than the client surface.

Use TanStack Query for async request state, caching, and mutations.

### Debug daemon-side behavior

Backend contributions can use normal Node logging. `console.log()` writes to the plugin's stdout;
`console.error()` writes to stderr. Paseo captures both streams without interfering with plugin IPC.

Inspect recent output after install, reload, an RPC failure, or a subprocess crash:

```bash
paseo plugin logs my-plugin
paseo plugin logs my-plugin --json
paseo plugin logs my-plugin --host <url>
```

The same tail is available from **Settings → Plugins → Logs**. It includes initialization, handler,
cleanup, and final crash output. Reload, disable, and process failure retain the tail. Removing the
plugin clears it; restarting the daemon clears the in-memory tail. Structured copies also go to the
daemon log. Never log credentials or other secrets.

## Add a composer attachment source

Define a search RPC and declarative source in `shared/`, handle it on the server, and register it on
the client:

```ts
// shared/issues.ts
import { defineAttachmentSource, defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const searchIssues = defineRpc({
  name: "issues.search",
  input: z.object({ query: z.string() }),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        identifier: z.string(),
        title: z.string(),
        subtitle: z.string().optional(),
        url: z.string().url(),
        text: z.string(),
        resourceType: z.string(),
      }),
    ),
  }),
});

const issues = defineAttachmentSource({
  id: "issues",
  title: "Acme issue",
  icon: "CircleDot",
  pickerTitle: "Attach Acme issue",
  searchPlaceholder: "Search by identifier or title",
  search: searchIssues,
});
```

```ts
// index.server.ts
import type { PluginServerContext } from "@getpaseo/plugin";
import { searchIssues } from "./shared/issues";

export default function contribute(server: PluginServerContext) {
  server.handle(searchIssues, ({ query }) => searchAcmeIssues(query));
  return () => {};
}
```

```tsx
// index.client.tsx
import type { PluginClientContext } from "@getpaseo/plugin";
import { issues } from "./shared/issues";

export default function contribute(client: PluginClientContext) {
  client.addAttachmentSource(issues);
  return () => {};
}
```

Return complete text snapshots. Paseo owns the composer menu, picker, pills, drafts, and submission. Credentials and vendor calls stay in the daemon handler.

## Add a client slash command

A slash command runs plugin code in the app when the user submits `/name args`. Nothing is sent to the agent. `args` is the raw text after the command name, trimmed; parse it in the plugin.

```ts
client.addSlashCommand({
  name: "review",
  description: "Run the review bot",
  argumentHint: "[scope]",
  context: "agent", // or "workspace" so drafts get it too
  async onSubmit({ args, agent, rpc, openPanel }) {
    await rpc(startReview, { agentId: agent.id, scope: args });
    openPanel("review");
  },
});
```

The callback receives the same context as the matching Command Center item plus `args`. Paseo owns the autocomplete row, input clearing, and the error toast; put pending UI in a pill or panel. Precedence is built-in client commands, then plugin commands, then provider commands; a lower-precedence collision is dropped. Commands do not run while the composer has attachments. Server-side slash commands do not exist.

## Add a composer pill

A pill is a per-agent button in the composer track bar next to Tasks and Subagents. Add and remove pills from the client entry lifecycle. `addComposerPill` exists on `PluginClientContext`.

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

Call `contributeClient(client)` from `index.client.tsx`, or move its body into that entry. The component owns its icon and text; Paseo owns the pressable, chrome, pending state, error reporting, and placement. Removal functions are idempotent, and Paseo removes every pill when the plugin, client entrypoint, or host connection is torn down.

## Transform and render timeline items

Timeline transformers and renderers are client contributions. A transformer selects one built-in `AgentTimelineItem.type`, inspects the item, and returns zero or more versioned plugin items. `undefined` keeps the source item, `items` replaces it, `[]` removes it. A renderer draws one `kind` and `version` after validating `data` with its Zod schema.

```ts
client.addTimelineTransformer({
  id: "inline-thinking",
  query: { itemType: "reasoning" },
  transform: ({ item, phase }) => ({
    items: [
      { type: "plugin", kind: "inline-thinking", version: 1, data: { text: item.text, phase } },
    ],
  }),
});
client.addTimelineRenderer({
  kind: "inline-thinking",
  version: 1,
  schema: z.object({ text: z.string(), phase: z.enum(["streaming", "complete"]) }),
  Component: InlineThinking,
});
```

Transformers run while the render model is built, on fetched history and on every live update, so `phase` is `"streaming"` for a loading thought or running tool call. Identity comes from the source item, so a streaming item keeps its mounted component; set an output `id` when one source explodes into several items. Transformers must be synchronous and deterministic, `data` must be JSON, and a transformer that throws is logged and skipped. Use `useRevealedText(text, phase)` from `@getpaseo/plugin/react-native` to pace streaming text. `plugin-examples/inline-thinking` replaces the thinking row with inline text; `plugin-examples/timeline-items` replaces a Pi todo tool call with a task card.

## Append a timeline row from the daemon

A server handler can push a plugin-owned row into any agent timeline. The same renderer registration draws it.

```ts
server.handle(publishReview, async ({ agentId, verdict }, { paseo }) => {
  await paseo.agents.ref(agentId).timeline.append({
    type: "plugin",
    id: "review",
    kind: "review-result",
    version: 1,
    data: { verdict },
  });
  return {};
});
```

The daemon stamps `pluginId` from the plugin session, so only plugin code can call this. Re-appending with the same `id` replaces the earlier row live and on refetch, which is how a plugin updates a row. `data` is capped at 64 KiB serialized and rejected above that. Rows live in the daemon's in-memory timeline and survive scroll, refetch, and reconnect, but not a daemon restart. A row whose plugin is missing renders an unavailable placeholder. Hosts advertise support through `server_info.features.pluginTimelineItems`.

## Contribute a theme

`addTheme` takes a small light or dark palette; Paseo expands it into the full token set. Every color is a hex string.

```ts
client.addTheme({
  id: "mocha",
  name: "Catppuccin Mocha",
  appearance: "dark",
  colors: {
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    raised: "#313244",
    control: "#45475a",
    border: "#45475a",
    accent: "#cba6f7",
    mutedForeground: "#a6adc8",
    ring: "#6c7086",
  },
});
```

It appears under Settings → Appearance. A client that predates `addTheme` cannot evaluate the entry and reports `client.addTheme is not a function`; update the client. See `plugin-examples/catppuccin`.

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

When the same sidebar contribution exists on several connected hosts, Paseo shows it once with a host picker. The selected host owns the bundle, SDK calls, RPCs, and query cache. An offline selected host does not fall through to another host. Attachment sources stay scoped to the composer's host.

## Typecheck and manage

Always typecheck before install or reload:

```bash
npm run typecheck
paseo plugin install /absolute/path/to/plugin
paseo plugin install /absolute/path/to/plugin --id another-runtime-id
paseo plugin add owner/repository              # Git source; append :path for a monorepo subdirectory
paseo plugin add owner/repository --ref main   # branches track, tags and commits pin
paseo plugin status
paseo plugin update my-plugin
paseo plugin ls
paseo plugin reload my-plugin
paseo plugin logs my-plugin
paseo plugin disable my-plugin
paseo plugin enable my-plugin
paseo plugin remove my-plugin
```

Use `--host <url>` when managing a daemon other than the CLI default. A Git source that must install or generate something declares `build` in `paseo-plugin.json` as a list of argv arrays; Paseo runs them without a shell on install and update and keeps the old version if one fails. Plugin source edits require `paseo plugin reload`; config changes to the global switch require `paseo reload`. A failed plugin reload stays failed; inspect `paseo plugin ls` for the load error and `paseo plugin logs <id>` for subprocess output, fix the source, typecheck, and reload again. `remove` deletes configuration, never the source directory.

Do not restart the daemon to load source changes. Restarting it can kill the agent performing the work.

For an old mixed entry, follow the standalone [v0.8 runtime-entry migration guide](https://paseo.sh/docs/plugins/v0.8/migration) mechanically.

## Verify the outcome

After a change:

1. Run `npm run typecheck`.
2. Install or reload the exact runtime ID.
3. Run `paseo plugin ls` and require `running` with no error.
4. Confirm the contribution on the intended host. Open the Command Center with **⌘K** (macOS) or **Ctrl+K** (Windows/Linux). Type `/` in the composer for slash commands. For timeline work, run an agent turn that produces the source item and watch it while it streams, not only after it completes. For UI work, check a wide desktop window and a compact/mobile client, and switch theme to confirm text still uses `foreground` / `foregroundMuted`.
5. Exercise the changed action or RPC, including its error state.

Common failures:

- Missing sidebar item: wrong host, plugin not `running`, invalid Lucide icon, or sidebar item points to a missing surface.
- Unavailable client module: client bundles can use only the host-provided modules listed above.
- RPC rejection: input or output failed its Zod schema, or the handler threw. Inspect `paseo plugin logs <id>` for handler output.
- Plugin exits or reload fails: inspect `paseo plugin ls` for status and `paseo plugin logs <id>` for initialization, cleanup, or crash output.
- Stale UI: source was edited without `paseo plugin reload <id>`.
- Timeline item shows "Plugin timeline item unavailable": no renderer registered for that `kind` and `version`, the renderer schema rejected `data`, or the plugin is not running on that host.
- Transformer has no effect: `query.itemType` does not match the source type, the transform returned `undefined`, or it threw and was skipped; check the app console for `[Plugins] Timeline transformer failed`.
- Slash command not offered: name collides with a built-in or another plugin, the context is `agent` on a draft, or the composer has attachments.
- Append rejected: the caller is not a plugin session, `data` exceeds 64 KiB, or the host predates `features.pluginTimelineItems`.
