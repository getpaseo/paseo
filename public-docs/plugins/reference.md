---
title: Plugin reference
description: Local plugin files, contributions, Paseo SDK access, RPCs, attachments, logs, lifecycle, hosts, and CLI commands.
nav: Reference
order: 46
category: Plugins
---

# Plugin reference

Local plugins are directory sources installed into one Paseo daemon. A plugin can contribute:

- React Native surfaces and sidebar items to Paseo clients;
- workspace and agent panels opened as workspace tabs;
- global, workspace, and agent actions in the Command Center;
- dark themes in Settings → Appearance;
- schema-validated RPC handlers running beside the daemon;
- normal Paseo operations through the TypeScript SDK;
- searchable external resources in the message composer.

Plugin code is trusted and unsandboxed. Client surfaces run in the Paseo app. Backend contributions run in a subprocess with access to the daemon machine, including its files, processes, credentials, and network.

## Project files

`paseo plugin init /absolute/path/to/my-plugin` creates:

```text
my-plugin/
  paseo-plugin.json
  index.ts
  main.client.tsx
  paseo-plugin.d.ts
  package.json
  tsconfig.json
```

The manifest contains the default plugin ID:

```json
{ "id": "my-plugin" }
```

Plugin, surface, sidebar-item, workspace-panel, Command Center item, and attachment-source IDs start with a lowercase letter and contain lowercase letters, numbers, or hyphens.

The generated declaration file supplies `@getpaseo/plugin` and `@getpaseo/plugin/server` types for local typechecking. Paseo supplies the runtime modules. Regenerate a fresh project with the matching CLI when the plugin contract changes.

Add runtime-specific files as the plugin grows:

```text
my-plugin/
  action.shared.ts
  action.server.ts
  panel.client.tsx
```

| Suffix         | Use it for                                                           |
| -------------- | -------------------------------------------------------------------- |
| `*.client.tsx` | React, React Native, hooks, styles, surfaces, panels, and callbacks. |
| `*.server.ts`  | Node APIs, local resources, credentials, and RPC handlers.           |
| `*.shared.ts`  | Zod RPC contracts and plain values imported by both runtimes.        |

## SDK modules

| Module                    | Use it for                                               |
| ------------------------- | -------------------------------------------------------- |
| `@getpaseo/plugin`        | hooks and UI types                                       |
| `@getpaseo/plugin/server` | `defineRpc`, `defineAttachmentSource`, and handler types |

Paseo rejects imports from `*.server` files into client modules and imports from `*.client` files into server modules. Keep shared modules free of Node and React Native runtime code.

## Entry point and cleanup

`index.ts` wires contributions together and default-exports one contribution function. It must return cleanup, even when it has nothing to clean:

```ts
import type { PluginContext } from "@getpaseo/plugin";
import { Main } from "./main.client";

export default function contribute(plugin: PluginContext) {
  plugin.addSurface("main", Main);
  return () => {};
}
```

Cleanup can be async. Release timers, watchers, sockets, and other resources created by the plugin. Paseo also removes registrations, unmounts surfaces, rejects pending RPCs, closes the plugin's daemon session, and stops its subprocess on reload, disable, removal, disconnect, or daemon shutdown.

## Surfaces and sidebar items

Register a component, then point a sidebar item at its surface ID:

`main.client.tsx`:

```tsx
import type { PluginSurfaceProps } from "@getpaseo/plugin";
import { useMemo } from "react";
import { Text, View } from "react-native";

export function Main({ theme, host, layout }: PluginSurfaceProps) {
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      },
      title: { color: theme.colors.foreground },
      detail: { color: theme.colors.foregroundMuted },
    }),
    [theme, layout.compact],
  );
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{host.label}</Text>
      <Text style={styles.detail}>{layout.platform}</Text>
    </View>
  );
}
```

`index.ts`:

```ts
import type { PluginContext } from "@getpaseo/plugin";
import { Main } from "./main.client";

export default function contribute(plugin: PluginContext) {
  plugin.addSurface("main", Main);
  plugin.addSidebarItem({
    id: "main",
    title: "My plugin",
    icon: "Blocks",
    surface: "main",
  });
  return () => {};
}
```

`PluginSurfaceProps` contains:

| Field    | Meaning                                                      |
| -------- | ------------------------------------------------------------ |
| `theme`  | Typed `PluginTheme` color tokens for the active Paseo theme. |
| `host`   | Selected host `id` and display `label`.                      |
| `layout` | `compact` and the `ios`, `android`, or `web` platform.       |

Paseo owns the route, header, close action, host picker, error boundary, and query client. The plugin owns the surface body. Icons use [Lucide](https://lucide.dev/icons/) names.

## Theme and layout

Plugin UI runs on desktop, browser, iOS, and Android, across every Paseo theme. `theme` is a typed `PluginTheme`. Color and spacing must come from those props. Unstyled `Text` is black and fails in dark themes.

Recreate styles when `theme` or `layout.compact` changes.

| Key                             | Required for               | Use it for                          |
| ------------------------------- | -------------------------- | ----------------------------------- |
| `theme.colors.foreground`       | Every primary `Text`       | Titles and body copy                |
| `theme.colors.foregroundMuted`  | Secondary `Text`           | Labels and supporting copy          |
| `theme.colors.surface0`         | Root view                  | Panel background                    |
| `theme.colors.accent`           | Primary action fills       | Buttons and selected states         |
| `theme.colors.accentForeground` | Text on an accent fill     | Button labels                       |
| `theme.colors.statusDanger`     | Failure copy               | Error messages and destructive text |
| `layout.compact`                | Padding and stacking       | `true` on mobile and narrow windows |
| `layout.platform`               | Platform-specific behavior | `ios`, `android`, or `web`          |

Do not hardcode `#000`, `#fff`, or React Native's default text color. Primary copy uses `foreground`. Labels use `foregroundMuted`. Tighten padding when `layout.compact` is true.

Workspace and agent panels receive the same `theme` and `layout` fields.

Client code can import `react`, `react-native`, `@tanstack/react-query`, `zod`, `@getpaseo/plugin`, and `@getpaseo/plugin/server`. Install them locally for typechecking; Paseo provides the client runtime instances.

## Contribute a theme

`addTheme` adds a dark theme to Settings → Appearance, listed under the built-ins by its `name`. A
theme is data, so it needs no client file:

```ts
import type { PluginContext } from "@getpaseo/plugin";

export default function contribute(plugin: PluginContext) {
  plugin.addTheme({
    id: "mocha",
    name: "Catppuccin Mocha",
    appearance: "dark",
    colors: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      raised: "#313244",
      control: "#45475a",
      accent: "#45475a",
      highlight: "#cba6f7",
      mutedForeground: "#a6adc8",
      ring: "#6c7086",
    },
  });
  return () => {};
}
```

Every color is a hex string; anything else fails to load. Paseo expands the palette into the full
token set the built-in dark themes use, so a contributed theme covers panels, menus, diffs, status
colors, and the terminal without listing them.

| Color             | Becomes                                                           |
| ----------------- | ----------------------------------------------------------------- |
| `background`      | App and sidebar background, terminal background                   |
| `foreground`      | Primary text, terminal foreground and cursor                      |
| `raised`          | Cards, popovers, and hovered rows                                 |
| `control`         | Inputs, secondary fills, and terminal black                       |
| `accent`          | Borders and the raised surface tint — not the vivid accent        |
| `highlight`       | Buttons, selection, and focus. Optional; `foreground` if omitted. |
| `mutedForeground` | Secondary text                                                    |
| `ring`            | Focus rings, scrollbars, and terminal bright black                |

`appearance` is `"dark"`. Light themes are not derived yet.

Only one contributed theme is active at a time. Selecting one persists the choice; if the plugin is
later disabled or removed, Paseo falls back to the default theme rather than leaving the app
unpainted.

## Workspace panels

Register one panel for workspace or agent context:

`review.client.tsx`:

```tsx
import { type PluginAgentPanelProps, useAgent, useWorkspace } from "@getpaseo/plugin";
import { useMemo } from "react";
import { Text, View } from "react-native";

export function ReviewPanel({ theme, layout, workspaceId, agentId }: PluginAgentPanelProps) {
  const workspaceName = useWorkspace(workspaceId, (workspace) => workspace.name);
  const agent = useAgent(agentId, ({ id, title }) => ({ id, title }));
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      },
      title: { color: theme.colors.foreground },
      detail: { color: theme.colors.foregroundMuted },
    }),
    [theme, layout.compact],
  );
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{workspaceName}</Text>
      <Text style={styles.detail}>{agent?.title ?? agent?.id}</Text>
    </View>
  );
}
```

`index.ts`:

```ts
import type { PluginContext } from "@getpaseo/plugin";
import { ReviewPanel } from "./review.client";

export default function contribute(plugin: PluginContext) {
  plugin.addWorkspacePanel({
    id: "review",
    title: "Review",
    icon: "Scan",
    context: "agent",
    Component: ReviewPanel,
  });
  return () => {};
}
```

`addWorkspacePanel` fields:

| Field       | Required | Meaning                                                       |
| ----------- | -------- | ------------------------------------------------------------- |
| `id`        | Yes      | Plugin-local panel ID.                                        |
| `title`     | Yes      | Workspace-tab title.                                          |
| `icon`      | Yes      | Lucide icon name.                                             |
| `context`   | Yes      | `workspace` or `agent`.                                       |
| `Component` | Yes      | React Native component matching the selected context's props. |

A workspace panel receives `PluginWorkspacePanelProps`: `context: "workspace"`, `theme`, `host`, `layout`, and `workspaceId`. An agent panel receives `PluginAgentPanelProps`: `context: "agent"`, the same common fields and `workspaceId`, plus `agentId`.

Read cached state with `useWorkspace(workspaceId, selector)` and `useAgent(agentId, selector)`. A selector is required. Paseo compares its result shallowly, so selecting `{ name, status }` does not re-render when unrelated fields change. Select every field the component renders in one call; do not select the whole snapshot.

Both hooks return `null` when the record is unavailable. Otherwise they run synchronously against normalized client state. Snapshot DTOs and their nested values are deeply readonly and frozen at runtime. Do not call plugin RPC to discover the current workspace or agent. Fetch optional or vendor-specific enrichment after the component renders.

Workspace snapshot fields:

| Field                | Type                                                              |
| -------------------- | ----------------------------------------------------------------- |
| `id`                 | `string`                                                          |
| `projectId`          | `string`                                                          |
| `projectDisplayName` | `string`                                                          |
| `projectRootPath`    | `string`                                                          |
| `directory`          | `string`                                                          |
| `projectKind`        | `"git" \| "non_git" \| "directory"`                               |
| `kind`               | `"directory" \| "local_checkout" \| "checkout" \| "worktree"`     |
| `name`               | `string`                                                          |
| `title`              | `string \| null`                                                  |
| `status`             | `"needs_input" \| "failed" \| "running" \| "attention" \| "done"` |
| `statusEnteredAt`    | ISO timestamp or `null`                                           |
| `archivingAt`        | ISO timestamp or `null`                                           |
| `diffStat`           | `{ additions: number; deletions: number } \| null`                |

Agent snapshot fields:

| Field               | Type                                                           |
| ------------------- | -------------------------------------------------------------- |
| `id`                | `string`                                                       |
| `workspaceId`       | `string`                                                       |
| `provider`          | `string`                                                       |
| `status`            | `"initializing" \| "idle" \| "running" \| "error" \| "closed"` |
| `createdAt`         | ISO timestamp                                                  |
| `updatedAt`         | ISO timestamp                                                  |
| `lastActivityAt`    | ISO timestamp                                                  |
| `title`             | `string \| null`                                               |
| `cwd`               | `string`                                                       |
| `model`             | `string \| null`                                               |
| `currentModeId`     | `string \| null`                                               |
| `thinkingOptionId`  | `string \| null`                                               |
| `requiresAttention` | `boolean`                                                      |
| `attentionReason`   | `"finished" \| "error" \| "permission" \| null`                |
| `parentAgentId`     | `string \| null`                                               |
| `labels`            | `Record<string, string>`                                       |

Paseo owns tab focus, splitting, closing, persistence, query state, the API/RPC providers, and the render error boundary. A restored tab whose plugin, panel, context, workspace, or agent is unavailable stays open with an unavailable message instead of crashing the workspace.

## Command Center items

Open the Command Center with **⌘K** on macOS or **Ctrl+K** on Windows and Linux, then search for the item title.

Register an action and open a panel from the callback:

```tsx
import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

const refreshReview = defineRpc({
  name: "review.refresh",
  input: z.object({ agentId: z.string() }),
  output: z.object({ refreshed: z.boolean() }),
});

plugin.addCommandCenterItem({
  id: "open-review",
  title: "Open review",
  icon: "Scan",
  keywords: ["inspect"],
  context: "agent",
  async onSelect({ paseo, rpc, workspace, agent, openPanel }) {
    await paseo.workspaces.ref(workspace.id).setTitle(`Review ${agent.id}`);
    await rpc(refreshReview, { agentId: agent.id });
    openPanel("review");
  },
});
```

`addCommandCenterItem` fields:

| Field      | Required | Meaning                                        |
| ---------- | -------- | ---------------------------------------------- |
| `id`       | Yes      | Plugin-local item ID.                          |
| `title`    | Yes      | Search result title.                           |
| `icon`     | Yes      | Lucide icon name.                              |
| `keywords` | No       | Additional Command Center search terms.        |
| `context`  | Yes      | `global`, `workspace`, or `agent`.             |
| `onSelect` | Yes      | Client-side callback for the matching context. |

Global items appear on the installation's selected host. Workspace items appear only when that host has an active cached workspace. Agent items appear only when the focused workspace tab is an agent or an agent-context plugin panel whose cached record belongs to that workspace. Missing context removes the item rather than calling the plugin to discover it.

Every callback receives:

| Field                  | Context             | Meaning                                                       |
| ---------------------- | ------------------- | ------------------------------------------------------------- |
| `context`              | All                 | Matching discriminator.                                       |
| `paseo`                | All                 | Selected host's existing `PaseoApi`.                          |
| `rpc(contract, input)` | All                 | Typed call to this installation's daemon-side plugin handler. |
| `openSurface(id)`      | All                 | Opens one of this plugin's registered global surfaces.        |
| `workspace`            | Workspace and agent | Synchronous workspace snapshot.                               |
| `agent`                | Agent               | Synchronous matching agent snapshot.                          |
| `openPanel(id)`        | Workspace and agent | Opens a registered panel in the callback's current context.   |

An agent callback may open either an agent panel or a workspace panel. A workspace callback may open only a workspace panel. Unknown surface and panel IDs fail visibly. Use `paseo` for normal workspace, agent, provider, and daemon-config operations. Use `rpc` for plugin-specific filesystem, credential, vendor, or daemon-local work.

## Use the Paseo SDK

Use `usePaseo()` for ordinary Paseo operations from a surface. It borrows the selected host's existing connection; do not create another client.

```tsx
import { usePaseo } from "@getpaseo/plugin";
import { Pressable, Text } from "react-native";

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

  return (
    <Pressable accessibilityRole="button" onPress={() => void createReviewWorkspace()}>
      <Text>Create review workspace</Text>
    </Pressable>
  );
}
```

The returned API covers workspaces, agents, providers, and daemon config. See the [SDK API reference](/docs/sdk/reference) for its methods. Connection lifecycle methods are intentionally absent because Paseo owns the connection.

## Add plugin-specific backend behavior

Use plugin RPC only for work that is not a normal Paseo operation: reading a vendor API, accessing daemon-local resources, or keeping credentials off the client.

Define one contract with Zod, handle it in the subprocess, and call it from the surface:

`greeting.shared.ts`:

```ts
import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

export const greeting = defineRpc({
  name: "greeting.create",
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string() }),
});
```

`greeting.client.tsx`:

```tsx
import { useRpc } from "@getpaseo/plugin";
import { greeting } from "./greeting.shared";

export function GreetingButton() {
  const createGreeting = useRpc(greeting);
  // Call createGreeting({ name: "Ada" }) from an event or query.
  return null;
}
```

`greeting.server.ts`:

```ts
import type { output as ZodOutput } from "zod";
import { greeting } from "./greeting.shared";

export function createGreeting({ name }: ZodOutput<typeof greeting.input>) {
  return { message: `Hello, ${name}` };
}
```

`index.ts`:

```ts
import type { PluginContext } from "@getpaseo/plugin";
import { GreetingButton } from "./greeting.client";
import { createGreeting } from "./greeting.server";
import { greeting } from "./greeting.shared";

export default function contribute(plugin: PluginContext) {
  plugin.handle(greeting, createGreeting);
  plugin.addSurface("main", GreetingButton);
  return () => {};
}
```

Inputs and outputs are validated on both sides. RPC names start with a lowercase letter and contain lowercase letters, numbers, dots, hyphens, or underscores. `useRpc()` returns a typed async function. Use TanStack Query for request state, caching, and mutations.

Backend handlers receive the same `PaseoApi` as `{ paseo }`. Their connection belongs to the subprocess and closes when the plugin stops. Backend code can use Node APIs and dependencies installed in the plugin directory.

## Debug backend output

Backend contributions can write to stdout and stderr with normal Node logging:

```ts
console.log("Refreshing issues");
console.error("Issue refresh failed", error);
```

Paseo adds `[paseo]` entries when the plugin starts loading, becomes ready, starts stopping, and has
stopped. It records compilation and load failures as stderr entries, including failures that happen
before the plugin subprocess starts. Paseo also captures output emitted during initialization, RPC
handlers, cleanup, and process failure. Protocol traffic uses a separate channel, so `console.log()`
cannot corrupt plugin RPCs.

Open **Settings → Plugins → Logs** for the plugin, or inspect the same recent tail from the daemon
CLI:

```bash
paseo plugin logs my-plugin
paseo plugin logs my-plugin --json
paseo plugin logs my-plugin --host <url>
```

The command returns a snapshot rather than following live output. Refresh the settings view or run
the command again for newer entries. Each entry includes its timestamp, stdout or stderr stream,
sequence, and message.

Paseo retains up to 500 entries and 256 KiB per plugin in memory. Individual lines are capped at
16 KiB. Reload, disable, compilation failure, initialization failure, and process failure retain the
tail. Removing the plugin clears it, and a daemon restart starts a new tail. Structured copies are
also written to the daemon log at `$PASEO_HOME/daemon.log`.

Only daemon-side output is captured. Logs from client surfaces remain in the app runtime. Do not log
credentials, access tokens, or other secrets: connected users can read the retained tail, and the
daemon log persists it.

## Add a composer attachment source

An attachment source searches external resources and returns a stable text snapshot for an agent prompt. Keep credentials and vendor calls in the backend handler.

`issues.shared.ts`:

```ts
import { defineAttachmentSource, defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

export const searchIssues = defineRpc({
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

export const issues = defineAttachmentSource({
  id: "issues",
  title: "Acme issue",
  icon: "CircleDot",
  pickerTitle: "Attach Acme issue",
  searchPlaceholder: "Search by identifier or title",
  search: searchIssues,
});
```

`issues.server.ts`:

```ts
import type { output as ZodOutput } from "zod";
import { searchIssues } from "./issues.shared";

export function search({ query }: ZodOutput<typeof searchIssues.input>) {
  return searchAcmeIssues(query);
}
```

`index.ts`:

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

Paseo owns the composer menu, search picker, selected pill, draft state, and submission. The `text` value is the complete snapshot sent to the agent.

## Hosts and lifecycle

Plugins are installed per daemon. When the same contribution exists on several connected hosts, Paseo shows one sidebar item and adds a host picker. The selected host supplies the bundle, Paseo API, RPC transport, and query cache. Calls never fall through to another host when the selected host is offline.

Attachment sources remain scoped to each composer's host.

Workspace panels and Command Center items stay scoped to the active host and exact cached context.
Reload replaces their registrations. Disable, removal, host disconnect, and evaluation failure
remove Command Center items and clear the installation's query state. An already-restored panel tab
remains as unavailable until its matching contribution returns or the user closes it. Panel render
failures stay inside the plugin error boundary.

## CLI reference

```bash
paseo plugin init /absolute/path/to/plugin
paseo plugin install /absolute/path/to/plugin
paseo plugin install /absolute/path/to/plugin --id another-runtime-id
paseo plugin ls
paseo plugin reload my-plugin
paseo plugin logs my-plugin
paseo plugin disable my-plugin
paseo plugin enable my-plugin
paseo plugin remove my-plugin
```

Pass `--host <url>` to management commands when the target is not the CLI's default daemon. `remove` deletes only the daemon configuration; it never deletes the source directory. The install-time `--id` is the runtime ID and allows the same directory to be installed more than once.

Run `npm run typecheck` before install or reload. Never edit the daemon config directly.

The daemon-wide **Enable plugins** switch lives under **Settings → Plugins**. A configured plugin remains `disabled` until that switch and the plugin's own enabled state are both on.

The switch is the root `pluginsEnabled` field in `config.json`. After changing it, run `paseo reload --json`. Enabling starts every configured plugin whose own `enabled` value is not `false`; disabling tears down all plugins. No daemon restart is required. Manual edits to plugin source entries are not reloaded—use the plugin lifecycle commands for those.

## Load failures

Use `paseo plugin ls` to read the current status and error.

| Symptom                      | Check                                                                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Sidebar item is missing      | The plugin is `running`, the item references an existing surface, the icon name is valid, and the client is on the installation's host. |
| Client module is unavailable | Import only the host-provided client modules listed above.                                                                              |
| RPC rejects                  | Check both Zod schemas and the daemon-side handler error.                                                                               |
| Edited code does not appear  | Run `npm run typecheck`, then `paseo plugin reload <id>`.                                                                               |
| Reload fails                 | Read `paseo plugin ls` and `paseo plugin logs <id>`, fix the source error, then reload; Paseo does not restore the previous bundle.     |
| Plugin exits unexpectedly    | Read `paseo plugin logs <id>` for retained initialization, cleanup, stderr, and final crash output.                                     |
