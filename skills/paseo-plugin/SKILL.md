---
name: paseo-plugin
description: Build and manage trusted local Paseo plugins. Use when the user asks to create, edit, install, reload, enable, disable, remove, or troubleshoot a Paseo plugin; add lifecycle hooks; transform agent configuration, environment, MCP servers, or workspace creation; automate permissions or turn follow-ups; add a screen, sidebar header or footer item, or workspace panel; add Command Center items or slash commands; add composer pills or attachment sources; transform, render, or append agent timeline items; contribute a theme; use Paseo from plugin code; or add plugin RPCs.
---

# Paseo plugins

Build or manage the requested plugin directly. Use the current public docs to catch contract changes, but keep working from this skill if the network is unavailable.

**User's request:** $ARGUMENTS

## Check current documentation

Fetch [https://paseo.sh/llms.txt](https://paseo.sh/llms.txt) first. Select and fetch the current plugin Markdown pages from that index before changing a plugin:

- [Plugin quickstart](https://paseo.sh/docs/plugins.md) ([browser page](https://paseo.sh/docs/plugins))
- [Publishing](https://paseo.sh/docs/plugins/publishing.md): npm package contents, dependencies, Git preparation, and private registries.
- [Plugin reference](https://paseo.sh/docs/plugins/reference.md) ([browser page](https://paseo.sh/docs/plugins/reference))

Use the deployed docs when they disagree with this skill. Do not send the user away to read them instead of completing the work.

In the Paseo repository, use `public-docs/plugins/reference.md` for the checkout's API, including
unreleased changes. Use `docs/plugins.md` for maintainer guidance. Complete contracts belong in the
public docs; this skill indexes the references and examples.

## What a plugin can contribute

Pick the contribution that matches the request. Each row names the registration, when it fits, and where the full contract lives. Most plugins combine several: a slash command that calls an RPC, which appends a timeline row, which a renderer draws.

| Contribution              | Registration                                                | Use it when                                                                                                   | Reference                                                                                          |
| ------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Screen and sidebar item   | `addScreen` + `addSidebarHeaderItem`/`addSidebarFooterItem` | A full screen of plugin UI, or sidebar header or footer rows that open a screen or popover                    | reference.md → Screens and sidebar items                                                           |
| Workspace panel           | `addWorkspacePanel`                                         | UI that lives as a tab beside agents, terminals, files, and diffs; `locations: ["explorer"]` for the Explorer | reference.md → Workspace panels                                                                    |
| Command Center item       | `addCommandCenterItem`                                      | A global, workspace, or agent action reachable from ⌘K                                                        | reference.md → Command Center items                                                                |
| Client slash command      | `addSlashCommand`                                           | A `/command args` in the composer that runs plugin code instead of prompting the agent                        | reference.md → Slash commands                                                                      |
| Composer pill             | `addComposerPill`                                           | A per-agent button in the composer track bar next to Tasks and Subagents                                      | reference.md → Composer pills                                                                      |
| Timeline transformer      | `addTimelineTransformer` + `addTimelineRenderer`            | Replace, explode, or hide a built-in timeline item, including while it streams                                | reference.md → Timeline items; `plugin-examples/timeline-items`, `plugin-examples/inline-thinking` |
| Timeline row              | `paseo.agents.ref(id).timeline.append(...)`                 | Push a plugin-owned row into an agent timeline from a server handler and update it later                      | reference.md → Append a timeline row from the daemon                                               |
| Attachment source         | `client.addAttachmentSource` + `server.handle`              | Let the user attach a searchable external resource, such as an issue, to a prompt                             | reference.md → Add a composer attachment source; `plugin-examples/linear`                          |
| Theme                     | `addTheme`                                                  | A light or dark palette under Settings → Appearance                                                           | reference.md → Contribute a theme; `plugin-examples/catppuccin`                                    |
| Plugin RPC                | `defineRpc` + `server.handle` + `useRpc`                    | Daemon-side work that is not a normal Paseo operation: vendor APIs, credentials, local files                  | reference.md → Add plugin-specific backend behavior                                                |
| Lifecycle events          | `server.on`                                                 | Observe agent/workspace lifecycle, inspect ended turns, and answer permission requests                        | [Lifecycle hooks](https://paseo.sh/docs/plugins/reference.md#lifecycle-hooks)                      |
| Creation and launch hooks | `server.before`                                             | Change agent config, provider options, MCP servers, environment, or workspace isolation before the operation  | [Before hooks](https://paseo.sh/docs/plugins/reference.md#before-hooks)                            |
| Paseo SDK                 | `usePaseo()` / handler `{ paseo }`                          | Normal Paseo operations: workspaces, agents, providers, config                                                | reference.md → Use the Paseo SDK                                                                   |

| Lifecycle task                                                      | Example                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Log all eleven hooks                                                | [lifecycle-logger](https://github.com/getpaseo/paseo/tree/main/plugin-examples/lifecycle-logger)       |
| Follow-ups, permissions, environment, provider switching, worktrees | [lifecycle-actions](https://github.com/getpaseo/paseo/tree/main/plugin-examples/lifecycle-actions)     |
| Inject MCP servers and change Codex sandbox/approval options        | [agent-configuration](https://github.com/getpaseo/paseo/tree/main/plugin-examples/agent-configuration) |

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

## Add a workspace panel

Workspace panels live beside agents, terminals, files, and diffs. Plugins run on desktop and
mobile, and Paseo has multiple themes. Every `Text` must take its color from `theme.colors`.
Use `layout.compact` for padding and stacking. Unstyled text is black and fails in dark themes.

```tsx
import {
  type PluginClientContext,
  type PluginWorkspacePanelProps,
  useWorkspace,
} from "@getpaseo/plugin/client";
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
`rpc(contract, input)`, `openScreen({ screenId, params? })`, and contextual `openPanel(id)`
capabilities.

## Add a screen and a sidebar item

Plugin screens use React Native primitives and work across desktop, browser, iOS, and Android. A sidebar item, in the header or the footer, is a component: render one or more `SidebarRow`s from `@getpaseo/plugin/client/ui`, with `SidebarSeparator` between groups, and call `openScreen` or `openPopover` from them. A screen's `title` is a string or a function of its `params`; its component receives the `params` it was opened with. Color text from `theme.colors` and pad from `layout.compact`.

```tsx
import type {
  PluginClientContext,
  PluginScreenProps,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

function Counter({ theme, layout }: PluginScreenProps) {
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

function CounterItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="ListPlus"
      active={currentScreen?.screenId === "main"}
      onPress={() => openScreen({ screenId: "main" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "Counter", Component: Counter });
  client.addSidebarHeaderItem({ id: "main", title: "Counter", Component: CounterItem });
  return () => {};
}
```

Icons are Lucide icon names. `theme` is a typed `PluginTheme` on every screen and panel. Primary text uses `theme.colors.foreground`; labels use `theme.colors.foregroundMuted`; the root view uses `theme.colors.surface0`. `layout.compact` is true on mobile and narrow windows. Paseo owns the route, header, host picker, close action, error boundary, and per-installation query client.

Before writing imports, classify each module as shared, client, or server. Follow the
[SDK import boundaries](https://paseo.sh/docs/plugins/reference.md#runtime-modules), including
transitive and type dependencies. The root is shared-only; hooks and client contexts belong to
`@getpaseo/plugin/client`, server contexts to `/server`, and host UI to `/client/react-native` or `/client/ui`.
Install dependencies locally for typechecking; Paseo supplies host runtime modules. JSX uses the
automatic runtime. Do not import `/client/host` from plugin code.

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

`usePaseo()` borrows the selected host's current connection. Never create another client inside a surface. It is the plugin's one client in every surface: release your subscriptions in your cleanup; plugin teardown ends the rest.

```tsx
import { usePaseo } from "@getpaseo/plugin/client";

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
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createGreeting } from "./server/greeting";
import { greeting } from "./shared/greeting";

export default function contribute(server: PluginServerContext) {
  server.handle(greeting, createGreeting);
  return () => {};
}
```

```tsx
// client/greeting.tsx
import { useRpc } from "@getpaseo/plugin/client";
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
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { searchIssues } from "./shared/issues";

export default function contribute(server: PluginServerContext) {
  server.handle(searchIssues, ({ query }) => searchAcmeIssues(query));
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
import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";

export function contributeClient(client: PluginClientContext) {
  const pills = new Map<string, PluginButtonRegistration>();
  const lifetime = new AbortController();
  const register = (agent: { id: string; workspaceId?: string | null }) => {
    if (lifetime.signal.aborted || !agent.workspaceId) return;
    const agentId = agent.id;
    const workspaceId = agent.workspaceId;
    pills.get(agentId)?.remove();
    pills.set(
      agentId,
      client.addComposerPill({
        id: "review",
        workspaceId,
        agentId,
        button: {
          title: "Open review",
          icon: "Scan",
          label: "Review",
          behavior: {
            kind: "action",
            onPress() {
              client.openPanel("review", { workspaceId, agentId });
            },
          },
        },
      }),
    );
  };
  const removeAll = () => {
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
  // An owned list subscription delivers existing agents, then updates, and a fresh snapshot after a reconnect.
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAll();
          for (const { agent } of entries) register(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") return register(update.agent);
          pills.get(update.agentId)?.remove();
          pills.delete(update.agentId);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("Agent observation failed", error);
    });
  return () => {
    lifetime.abort();
    removeAll();
  };
}
```

Call `contributeClient(client)` from `index.client.tsx`, or move its body into that entry. The `button` descriptor sets the icon, label, and behavior; Paseo owns the pressable, chrome, pending state, error reporting, and placement. `addComposerPill` returns a registration with `update()` and `remove()`. `remove()` is idempotent, and Paseo removes every pill when the plugin, client entrypoint, or host connection is torn down.

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

Transformers run while the render model is built, on fetched history and on every live update, so `phase` is `"streaming"` for a loading thought or running tool call. Identity comes from the source item, so a streaming item keeps its mounted component; set an output `id` when one source explodes into several items. Transformers must be synchronous and deterministic, `data` must be JSON, and a transformer that throws is logged and skipped. Use `useRevealedText(text, phase)` from `@getpaseo/plugin/client/react-native` to pace streaming text. `plugin-examples/inline-thinking` replaces the thinking row with inline text; `plugin-examples/timeline-items` replaces a Pi todo tool call with a task card.

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

When the same screen or sidebar item exists on several connected hosts, Paseo shows it once. The screen header has a host picker; a sidebar item uses the host of the screen on display, else the host last picked in one of the plugin's screens. The selected host owns the bundle, SDK calls, RPCs, and query cache. An offline selected host does not fall through to another host. Attachment sources stay scoped to the composer's host.

## Publishing a listing

Write `OVERVIEW.md` beside `paseo-plugin.json` and include it in the published artifact.
README serves people browsing the project on GitHub; the overview helps people choose a
plugin in Paseo. Replace the scaffold's three guidance comments with factual content before
publishing. The scaffold includes the overview in the npm `files` list.

Listing resolution uses the reviewed artifact in this order:

1. The `readme` path in the artifact's `paseo-listing.json`, if set.
2. `OVERVIEW.md` beside the artifact's manifest, under `pluginPath` for monorepos.
3. `plugins/<owner>/<slug>.md` in the registry repository.
4. The artifact's `README.md`.
5. The artifact's `readme.md`.

The registry copy is an import-time stopgap. On the version bump that ships the author's
`OVERVIEW.md`, the reviewer removes the registry copy.

Apply the same contract to author overviews and registry stopgaps: 80–250 words, sentence
case, and plain factual language. Start with what the plugin does and the workflow it
supports, then requirements (daemon version, operating systems, providers, accounts, other
plugins, external tools), then considerations (permissions, what it reads, what it sends and
where, known limits). State only applicable requirements and behavior the plugin implements.
Omit install instructions (the listing page has the command), badges, changelog,
contributing sections, and marketing. See
[Your listing page](https://paseo.sh/docs/plugins/publishing.md#your-listing-page).

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

- Missing sidebar item: wrong host, plugin not `running`, the item is hidden in Settings > Sidebar, or its component throws (an invalid Lucide icon name throws).
- Unavailable client module: client bundles can use only the host-provided modules listed above.
- RPC rejection: input or output failed its Zod schema, or the handler threw. Inspect `paseo plugin logs <id>` for handler output.
- Plugin exits or reload fails: inspect `paseo plugin ls` for status and `paseo plugin logs <id>` for initialization, cleanup, or crash output.
- Stale UI: source was edited without `paseo plugin reload <id>`.
- Timeline item shows "Plugin timeline item unavailable": no renderer registered for that `kind` and `version`, the renderer schema rejected `data`, or the plugin is not running on that host.
- Transformer has no effect: `query.itemType` does not match the source type, the transform returned `undefined`, or it threw and was skipped; check the app console for `[Plugins] Timeline transformer failed`.
- Slash command not offered: name collides with a built-in or another plugin, the context is `agent` on a draft, or the composer has attachments.
- Append rejected: the caller is not a plugin session, `data` exceeds 64 KiB, or the host predates `features.pluginTimelineItems`.
