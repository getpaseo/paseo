---
name: paseo-plugin
description: Build and manage trusted Paseo plugins. Use when the user asks to create, edit, install, reload, enable, disable, remove, publish, or troubleshoot a Paseo plugin, or to add a plugin contribution such as a screen, sidebar item, sidebar view, workspace row badge, workspace, agent, or file panel, Command Center item, slash command, header button, composer pill, composer control, attachment source, New workspace field, settings screen, theme, timeline item, lifecycle hook, system prompt instructions, agent tools, MCP servers, agent provider, usage source, worktree manager, plugin RPC or subscription, or Paseo SDK calls from plugin code.
---

# Paseo plugins

Build or manage the plugin that the user asked for. Do the work yourself. Do not send the user to the docs in place of the work.

Use the user's request and the current conversation as input, including any arguments supplied with the skill invocation.

This skill gives the workflow, a map of every contribution, and the rules that break plugins most often. The public docs hold the complete contract of each contribution.

## Read the current contract

Before you write a contribution, read its section in the docs:

- In a Paseo checkout, read the files in `public-docs/plugins/`. They describe the API of that checkout, including unreleased changes.
- Elsewhere, fetch [https://paseo.sh/llms.txt](https://paseo.sh/llms.txt), then fetch the plugin pages that it lists.
- If the network is not available, continue from this skill.

| Page                                                            | Read it for                                                                                                      |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [Quickstart](https://paseo.sh/docs/plugins.md)                  | A first plugin, installation, and reload                                                                         |
| [Reference](https://paseo.sh/docs/plugins/reference.md)         | Client contributions, host UI, the Paseo SDK, RPCs, usage sources, worktree managers, the CLI, and load failures |
| [Hooks](https://paseo.sh/docs/plugins/hooks.md)                 | Lifecycle hooks, payloads, ordering, agent tools, and MCP servers                                                |
| [Provider plugins](https://paseo.sh/docs/plugins/providers.md)  | Coding agents added as providers, direct or through ACP                                                          |
| [Sidebar views](https://paseo.sh/docs/plugins/sidebar-views.md) | Sidebar views and the ref queries that feed them                                                                 |
| [Publishing](https://paseo.sh/docs/plugins/publishing.md)       | The listing page, npm, Git, and the plugin registry                                                              |
| [Migration](https://paseo.sh/docs/plugins/migration.md)         | Plugins written before 0.8 runtime entries, and renamed APIs                                                     |

If the docs and this skill disagree, follow the docs.

## Choose the contributions

A plugin usually combines several contributions. For example, a slash command calls an RPC, the RPC handler appends a timeline row, and a renderer draws the row.

Build only on the registrations below. If no registration fits what the user wants, tell the user. Do not import Paseo internals or `@getpaseo/plugin/client/host`.

### Client contributions

Register these on `client` in `index.client.tsx`. Each returns a remover. `addHeaderButton` and `addComposerPill` return `{ update, remove }` instead.

| Registration                                    | Use it for                                                                                                                   | Docs section                                 | Example                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------- |
| `addScreen`                                     | A full page of plugin UI. Open it with `openScreen({ screenId, params })`.                                                   | Reference > Screens and sidebar items        | `hosts`                             |
| `addSidebarHeaderItem`, `addSidebarFooterItem`  | Sidebar rows, drawn with `SidebarRow`, that open a screen or a popover                                                       | Reference > Sidebar items                    | `hosts`                             |
| `addSidebarView`                                | A replacement for the sidebar list. The user selects it in Settings > Sidebar.                                               | Sidebar views                                | `sidebar-views`                     |
| `addWorkspaceRowBadgeItem`                      | Badges under each workspace title, drawn with `WorkspaceRowBadge`                                                            | Reference > Workspace row badge items        | `workspace-row-badges`              |
| `addWorkspacePanel`, `addAgentPanel`            | A tab beside agents, terminals, and files. Add `locations: ["explorer"]` to show it in the Explorer.                         | Reference > Workspace panels                 | `local-plugin`                      |
| `addFilePanel`                                  | A view or editor for files that match `files: { extensions, filenames }`                                                     | Reference > File panels                      | `pdf-panel`, `markdown-panel`       |
| `addCommandCenterItem`                          | A global, workspace, or agent action in the Command Center                                                                   | Reference > Command Center items             | `local-plugin`                      |
| `addSlashCommand`                               | A `/name args` command that runs plugin code and sends nothing to the agent                                                  | Reference > Slash commands                   | `translations`                      |
| `addHeaderButton`                               | An action, menu, or popover in the workspace header                                                                          | Reference > Header buttons                   | `buttons`                           |
| `addComposerPill`                               | A button above the composer of one agent, beside Tasks and Subagents                                                         | Reference > Composer pills                   | `local-plugin`                      |
| `addComposerItem`                               | Composer controls that change the prompt, model, mode, provider options, or agent metadata through `useComposer()`           | Reference > Composer items                   | `composer-controls`                 |
| `addNewWorkspaceItem`                           | A field on the New workspace screen that sets the branch, base, isolation, or workspace metadata through `useNewWorkspace()` | Reference > New workspace items              | `new-workspace-issues`              |
| `addAttachmentSource`                           | Outside resources, such as issues, that the user searches and attaches to a prompt                                           | Reference > Add a composer attachment source | `linear`                            |
| `addSettingsScreen`                             | A settings tab for the plugin under Settings > Plugins                                                                       | Reference > Settings screens                 | `settings`                          |
| `addTheme`                                      | A light or dark palette under Settings > Appearance                                                                          | Reference > Contribute a theme               | `catppuccin`                        |
| `addTimelineTransformer`, `addTimelineRenderer` | Replacing, splitting, or hiding a built-in timeline item, also while it streams                                              | Reference > Timeline items                   | `inline-thinking`, `timeline-items` |

Examples live in [`plugin-examples/`](https://github.com/getpaseo/paseo/tree/main/plugin-examples).

The client context also has `paseo`, `rpc`, `subscribe`, `openScreen`, `openPanel`, `openSettings`, `composers`, `playAudio`, and `i18n`. Import hooks such as `usePaseo`, `useRpc`, `useSubscription`, `useSettings`, `useWorkspace`, `useAgent`, and `useTabState` from `@getpaseo/plugin/client`.

### Server contributions

Register these on `server` in `index.server.ts`.

| Registration                | Use it for                                                                                    | Docs section                                                                       | Example                                       |
| --------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------- |
| `handle(contract, handler)` | Plugin RPCs from `defineRpc` and event streams from `defineSubscription`                      | Reference > Add plugin-specific backend behavior and Stream events from the daemon | `diff-watch`                                  |
| `addHook(name, handler)`    | Changing or observing workspace, worktree, and agent operations                               | Hooks                                                                              | `lifecycle-actions`, `lifecycle-logger`       |
| `registerSettings`          | A persisted settings document from `defineSettings` that server code reads                    | Reference > Settings screens                                                       | `settings`                                    |
| `registerProvider`          | A coding agent as a Paseo provider. Use `runAcpProvider` from `/server/acp` for an ACP agent. | Provider plugins                                                                   | `provider-direct`, `provider-acp-transformer` |
| `registerUsageSource`       | Quota reports for the logins of a provider, with helpers from `/server/usage`                 | Reference > Usage sources                                                          |                                               |
| `registerWorktreeManager`   | An outside tool, such as Worktrunk, that creates, removes, and restores Git worktrees         | Reference > Worktree managers                                                      | `worktrunk`                                   |

Server handlers and hooks receive `{ paseo }`. Call `paseo.agents.ref(id).timeline.append(item)` to put a plugin-owned row in an agent timeline. `@getpaseo/plugin/server` also exports `defineAgentTool`, `execCommand`, `spawnProcess`, and `terminateProcess`.

Do not write `server.on` or `server.before`. They are deprecated aliases. When you edit a plugin that uses them, move each one to `addHook`. The Renamed hooks table in Hooks gives the new name for each old name.

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
  client/web.ts
  server/greeting.ts
  shared/greeting.ts
```

The manifest supplies the default installation ID and the supported Paseo versions:

```json
{ "id": "my-plugin", "requirements": { "paseo": ">=0.8.0" } }
```

Keep `requirements.paseo` correct each time you create or edit a plugin:

- `init` writes `>=` followed by the CLI version.
- Raise the minimum when you use an API from a newer release. The reference names the release for each newer API.
- Add an upper bound when a later release breaks the plugin.
- A missing `requirements.paseo` means `<0.8.0`. Finish the [migration](https://paseo.sh/docs/plugins/migration.md) before you add `>=0.8.0`.

The daemon and each app check the range separately. Make sure that the daemon and the app both satisfy it.

Each runtime has its own entry. A plugin needs at least one entry.

| Path                             | Runtime                             |
| -------------------------------- | ----------------------------------- |
| `index.client.tsx` and `client/` | The Paseo app, once for each client |
| `index.server.ts` and `server/`  | A daemon subprocess                 |
| `shared/`                        | Both runtimes                       |

Paseo compiles each entry into its own bundle and rejects imports across the boundary:

- Client code cannot import `server/` or a `node:` module.
- Server code cannot import `client/`, React, or React Native.
- `shared/` holds Zod contracts and plain values only.
- Put every other code module in `client/`, `server/`, or `shared/`. A code module in the plugin root is a compile error.
- Import shared helpers such as `defineRpc` from `@getpaseo/plugin`, client contexts and hooks from `/client`, Paseo UI from `/client/ui`, and server contexts from `/server`.

These rules apply to type imports and to transitive imports too.

Each entry default-exports one function and returns cleanup:

```tsx
// index.client.tsx
import type { PluginClientContext } from "@getpaseo/plugin/client";

export default function contribute(client: PluginClientContext) {
  // Register client contributions here.
  return () => {};
}
```

```ts
// index.server.ts
import type { PluginServerContext } from "@getpaseo/plugin/server";

export default function contribute(server: PluginServerContext) {
  // Register handlers, hooks, and providers here.
  return () => {};
}
```

Cleanup can be async. Use it to release the timers, watchers, sockets, and subscriptions that your code created. When a plugin stops, Paseo runs the entry cleanup, removes the remaining registrations, and stops the subprocess.

## Write client UI that works on every platform

Client code runs on desktop, in browsers, and on iOS and Android. A component that works in the browser and crashes on a phone is the most common plugin bug.

- Use React Native primitives: `View`, `Text`, `Pressable`, `ScrollView`, and `TextInput`.
- Do not use HTML elements, `className`, CSS strings, `onClick`, or DOM globals.
- Do not add `"DOM"` to `tsconfig.json` or write `/// <reference lib="dom" />`. Put DOM code only in `client/web.ts`, gate each export on `Platform.OS === "web"`, and give native a fallback or a no-op.
- Take every color from `theme.colors`. Text without a color is black and cannot be read in dark themes. Use `foreground` for text, `foregroundMuted` for labels, and `surface0` for the root view.
- Use `layout.compact` for padding and stacking. It is true on phones and narrow windows.
- Set `icon` fields to a [Lucide](https://lucide.dev/icons/) name, an inline `{ svg }`, or a component. Do not import `lucide-react-native` or `react-native-svg`.

Before you report a plugin done, run this audit on `client/`. A hit outside `client/web.ts` is a bug.

```bash
rg -n "document\.|window\.|localStorage|navigator\.|<[a-z]+[ >]|className=|onClick=" client/
```

Read and change data through the API that owns it:

- Read cached workspace and agent state with `useWorkspace(id, selector)` and `useAgent(id, selector)`. Select only the fields you render. Do not add an RPC to find the active workspace or agent.
- Use `usePaseo()` for normal Paseo operations on projects, workspaces, agents, terminals, providers, and daemon configuration. It is the plugin's one client for the selected host. Do not create another client, and release the subscriptions that you open.
- Use a plugin RPC only for work that Paseo does not do: vendor APIs, credentials, local files, and shell commands.
- Use TanStack Query for request state, caching, and mutations.

### Add a workspace panel

A workspace panel opens as a tab beside agents, terminals, and files. This plugin also adds a Command Center item that opens it:

```tsx
// index.client.tsx
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

Register a panel that belongs to one agent with `addAgentPanel`, and read `params.agentId` in it. Command Center callbacks receive `paseo`, `rpc`, `openScreen`, and, in workspace and agent context, `openPanel`.

### Add a screen and a sidebar item

A sidebar item is a component. It renders one or more `SidebarRow`s and decides what a press does:

```tsx
// index.client.tsx
import type {
  PluginClientContext,
  PluginScreenProps,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

function Counter({ theme, layout }: PluginScreenProps) {
  const [count, setCount] = useState(0);
  return (
    <View
      style={{ flex: 1, padding: layout.compact ? 16 : 24, backgroundColor: theme.colors.surface0 }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Increment counter, currently ${count}`}
        onPress={() => setCount((value) => value + 1)}
      >
        <Text style={{ color: theme.colors.foreground }}>Count: {count}</Text>
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

Call `openPopover(Content)` from an item to open a popover instead of a screen. Paseo owns the route, the header, the host picker, and the error boundary of a screen.

### Add a composer control

A composer item renders in the composer of a running agent, of a draft agent, and of the New workspace screen. `useComposer()` returns the composer that the item sits in:

```tsx
// index.client.tsx
import { type PluginClientContext, useComposer } from "@getpaseo/plugin/client";
import { Action, Toggle } from "@getpaseo/plugin/client/ui";

function ReviewFlag() {
  const composer = useComposer();
  return (
    <Toggle
      title="Needs review"
      icon="Flag"
      value={composer.agent.metadata["review.needsReview"] === true}
      onValueChange={({ value }) =>
        composer.setMetadata({ "review.needsReview": value ? true : null })
      }
    />
  );
}

function Checklist() {
  const composer = useComposer();
  return (
    <Action
      title="Insert checklist"
      icon="ListChecks"
      onPress={async () => {
        composer.insertText("- [ ] Tests\n- [ ] Docs\n");
        await composer.focus();
      }}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addComposerItem({ id: "review-flag", Component: ReviewFlag });
  client.addComposerItem({ id: "checklist", Component: Checklist });
  return () => {};
}
```

Paseo places each control inline when the composer has room, and in the overflow sheet when it does not. On a phone, controls are always in the sheet. Keep effects in an item safe to run twice, because the sheet mounts a second instance. To reach a composer from outside it, call `useComposers({ agentId })`, `useComposers({ focused: true })`, or `client.composers(selector)`.

## Add daemon-side behavior

Define one Zod contract in `shared/`, handle it in `index.server.ts`, and call it from client code with `useRpc()`. `paseo plugin init` generates this RPC with the same files and export names:

```ts
// shared/greeting.ts
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const greetingRpc = defineRpc({
  name: "greeting.create",
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string() }),
});
```

```ts
// server/greeting.ts
import type { RpcInput } from "@getpaseo/plugin";
import type { greetingRpc } from "../shared/greeting";

export async function createGreeting({ name }: RpcInput<typeof greetingRpc>) {
  return { message: `Hello, ${name}!` };
}
```

```ts
// index.server.ts
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createGreeting } from "./server/greeting";
import { greetingRpc } from "./shared/greeting";

export default function contribute(server: PluginServerContext) {
  server.handle(greetingRpc, createGreeting);
  return () => {};
}
```

```tsx
// client/greeting.tsx
import { type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import { greetingRpc } from "../shared/greeting";

export function GreetingScreen({ theme, layout }: PluginScreenProps) {
  const createGreeting = useRpc(greetingRpc);
  const greeting = useMutation({ mutationFn: createGreeting });
  return (
    <View
      style={{ flex: 1, padding: layout.compact ? 16 : 24, backgroundColor: theme.colors.surface0 }}
    >
      <Pressable accessibilityRole="button" onPress={() => greeting.mutate({ name: "Ada" })}>
        <Text style={{ color: theme.colors.foreground }}>
          {greeting.data?.message ?? "Ask the daemon for a greeting"}
        </Text>
      </Pressable>
    </View>
  );
}
```

The generated `index.client.tsx` registers `GreetingScreen` as a screen and adds a Greeting sidebar item that opens it. Keep it to try the RPC from the app.

- Paseo validates the input and the output on both sides. A top-level `Uint8Array`, declared as `z.instanceof(Uint8Array)`, crosses as binary. A nested one fails validation.
- For a stream of events, use `defineSubscription`, `server.handle`, and `useSubscription`.
- Keep credentials, file access, shell commands, and vendor calls in the server handler.
- `console.log` and `console.error` in server code go to the plugin logs. Do not log credentials.

## Hook into agent and workspace operations

Register an async handler with `server.addHook(name, handler)`. This plugin adds instructions and an MCP server each time a Codex agent opens:

```ts
// index.server.ts
import type { PluginServerContext } from "@getpaseo/plugin/server";

export default function contribute(server: PluginServerContext) {
  server.addHook("agent.open.before", async ({ request }) => {
    if (request.provider !== "codex" || request.background) return;
    return {
      ...request,
      appendSystemPrompt: [
        ...(request.appendSystemPrompt ?? []),
        "Follow the team engineering guide.",
      ],
      mcpServers: {
        ...request.mcpServers,
        company: { type: "http", url: "https://tools.example.com/mcp" },
      },
    };
  });
  return () => {};
}
```

| Hook                                                             | Waits | Use it to                                                                                       |
| ---------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------- |
| `workspace.create.before`                                        | Yes   | Change the create request, such as the isolation                                                |
| `worktree.create.before`                                         | Yes   | Change the branch, slug, or path of a new worktree                                              |
| `worktree.create.after`                                          | Yes   | Prepare files in the worktree, or throw to stop creation                                        |
| `agent.create.before`                                            | Yes   | Change the saved configuration, `env`, or `metadata` of a new agent                             |
| `agent.open.before`                                              | Yes   | Add launch-only `env`, `appendSystemPrompt`, `tools`, and `mcpServers` each time an agent opens |
| `workspace.create.after`, `workspace.archive.after`              | No    | Observe workspaces                                                                              |
| `agent.create.after`, `agent.close.after`, `agent.archive.after` | No    | Observe agents                                                                                  |
| `agent.turn.before`, `agent.turn.after`                          | No    | Observe turns. Read the turn and send a follow-up through `paseo`.                              |
| `agent.permission.before`, `agent.permission.after`              | No    | Answer a pending permission through `paseo`, or observe its result                              |

- Every handler must be async.
- A waiting hook that throws, returns invalid data, or runs longer than 30 seconds fails the operation.
- A notification hook that fails only logs an error, and the operation continues.
- Return a complete replacement request, or `undefined` to keep the request.
- In `agent.open.before`, do not await a write to the agent that is opening, such as `setMetadata`. The write waits for the open, so the hook times out. Start the write without `await`.
- Put configuration that must be saved with the agent in `agent.create.before`. Changes from `agent.open.before` apply to one launch only.
- `tools` and `mcpServers` start empty for each plugin. Define tools with `defineAgentTool`.
- When a plugin with an `agent.open.before` hook starts, stops, or reloads, each open agent reopens before its next prompt. A running turn is not interrupted.

## Hosts and trust

Plugins are installed for each daemon. They are trusted code with no sandbox. Server code can use the files, processes, credentials, and network of the daemon machine. Client code runs inside the Paseo app. Do not install a plugin that the user has not authorized, or source code that you have not read.

When several connected hosts have the same plugin, Paseo shows its screens and sidebar items once and adds a host picker. The selected host owns the bundle, SDK calls, RPCs, and query cache. Paseo does not fall back to another host when the selected host is offline.

### Check the global switch before you install

1. Find the target daemon. For the local daemon, `paseo daemon status --json` reports its `home`. The configuration file is `<home>/config.json`.
2. Read the root `pluginsEnabled` field. A missing field means `false`. Do not infer the switch from the status of one plugin, because each plugin can also be disabled.
3. If `pluginsEnabled` is `true`, continue.
4. If it is `false` or missing, stop. Ask the user for permission before you change anything, and include this warning:

   > Plugins are trusted, unsandboxed code. Backend plugin code can access your daemon machine, including files, processes, credentials, and network services. Client plugin code runs inside the Paseo app. May I enable plugins on this daemon?

5. If the user does not agree, stop.
6. Set the root `pluginsEnabled` field to `true`, and keep the rest of `config.json`.
7. Run `paseo reload --json` against that daemon.
8. Make sure that `appliedPaths` contains `pluginsEnabled`. If `appliedPaths` is empty, read the file again and make sure that the plugin catalog is enabled.
9. After installation, run `paseo plugin ls` and make sure that the plugin reaches `running`.

To turn the switch off, set `pluginsEnabled` to `false`, run `paseo reload --json`, and make sure that the plugins report `disabled`.

If the daemon is remote, do not edit a local file. Edit the file on the daemon machine, or ask the user to use Settings > Plugins > Enable plugins. `paseo reload --host <url>` reloads the remote file but does not edit it.

## Develop in a local folder

Develop a plugin in a folder that you own and install that folder by path. Paseo runs the plugin from that folder, and `paseo plugin reload <id>` loads your edits.

Do not edit, build, or commit inside the installation of a Git, npm, or registry plugin. That folder is managed storage in the `plugins/` directory of the daemon home. `paseo plugin update` replaces it, and `paseo plugin remove` deletes it, with every edit and commit inside it.

Before you edit an installed plugin, run `paseo plugin ls <id>` and read the SOURCE column. A `git:`, `npm:`, or registry source such as `<registry host>/owner/slug` is a managed installation. The DIRECTORY column shows its managed folder.

To develop a plugin that is installed from Git, npm, or the registry:

1. Clone the source repository of the plugin into a folder outside the daemon home. For an npm plugin, find the repository in its `package.json`.
2. If SOURCE ends with `:<path>`, use that subfolder of the clone as the plugin folder.
3. If the managed folder has edits or commits, move them into the plugin folder.
4. In the plugin folder, install the dependencies and run the `build` commands from `paseo-plugin.json`. Paseo runs `build` only for managed installations.
5. Ask the user before you remove the managed installation. `paseo plugin remove <id>` also deletes the saved settings of the plugin.
6. Run `paseo plugin remove <id>`.
7. Run `paseo plugin install /absolute/path/to/plugin-folder --id <id>` to keep the runtime ID.
8. Edit the plugin folder. After each change, run its `build` commands if the change needs them, then run `paseo plugin reload <id>`.

## Install, reload, and debug

Typecheck the plugin before each install or reload:

```bash
npm run typecheck
paseo plugin install /absolute/path/to/plugin
paseo plugin install /absolute/path/to/plugin --id another-runtime-id
paseo plugin install acme/review
paseo plugin install npm:@acme/paseo-review@1.2.0
paseo plugin install github:owner/repository --ref main
paseo plugin ls
paseo plugin reload my-plugin
paseo plugin logs my-plugin
paseo plugin update my-plugin
paseo plugin disable my-plugin
paseo plugin enable my-plugin
paseo plugin remove my-plugin
```

- `install` and `add` are aliases. A bare `owner/slug` installs from the plugin registry.
- Put `--host <url>` before a command to manage a daemon other than the CLI default.
- Source edits need `paseo plugin reload <id>`. A change to the global switch needs `paseo reload`.
- Do not restart the daemon to load changes. A restart can stop the agent that does the work.
- A failed reload stays failed. Read the load error in `paseo plugin ls` and the output in `paseo plugin logs <id>`, fix the source, typecheck, and reload again.
- `paseo plugin logs <id>` shows the recent stdout and stderr of the subprocess, including initialization, handler, cleanup, and crash output. Settings > Plugins > Logs shows the same output.
- `remove` keeps a local folder and deletes a managed installation.
- Most plugins do not need `build`. Declare it in `paseo-plugin.json` only when the plugin must install a dependency or generate files after acquisition. Paseo skips npm lifecycle scripts, so an npm plugin that generates files declares `build` too. Reference: CLI reference describes the format, and Publishing > Plugins with a build step describes the npm rules.

## Publish

Follow [Publishing](https://paseo.sh/docs/plugins/publishing.md) to publish on npm or Git and to submit to the registry.

To maintain the listing page yourself, put `OVERVIEW.md` beside `paseo-plugin.json` and include it in the npm package. Without it, the registry reviewer writes the page. Explain these points in order:

1. What the plugin does.
2. How it works, if that is not obvious.
3. Setup: settings, accounts, tokens, external tools, and supported operating systems and Paseo versions.
4. Capabilities, settings, the data it reads and where it sends that data, permissions, and limits.

Use plain facts and sentence case. Do not include installation commands. The validator rejects `paseo plugin add`, `npm install`, and `npm i` anywhere in the overview. Also leave out badges, changelogs, and marketing.

## Verify the outcome

After each change:

1. Run `npm run typecheck`.
2. Install or reload the exact runtime ID.
3. Run `paseo plugin ls` and make sure that the plugin is `running` with no error.
4. Find the contribution on the intended host. Open the Command Center with Cmd+K on macOS or Ctrl+K on Windows and Linux. Type `/` in the composer to see slash commands. For a sidebar view, select it in Settings > Sidebar.
5. For timeline work, run an agent turn that produces the source item and watch it while it streams.
6. For UI work, check a wide desktop window and a compact window, and switch to a dark theme.
7. Use the changed action, RPC, or hook, and check its error state.

If it fails, find the symptom:

| Symptom                                                  | Check                                                                                                                                                            |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A sidebar item is missing                                | The host, the `running` status, Settings > Sidebar, and whether the component throws. A `SidebarRow` with an unknown Lucide name throws.                         |
| A sidebar view does not show                             | The user must select it in Settings > Sidebar. Installation does not select it.                                                                                  |
| A client module is not available                         | Client bundles can import only `@getpaseo/plugin`, its `/client` and `/client/ui` entries, `react`, `react-native`, `@tanstack/react-query`, and `zod`.          |
| An RPC rejects                                           | The input or output failed its Zod schema, or the handler threw. Read `paseo plugin logs <id>`.                                                                  |
| A hook fails an operation                                | The handler threw, returned invalid data, or ran longer than 30 seconds. Read `paseo plugin logs <id>`.                                                          |
| The UI shows old code                                    | The source changed without `paseo plugin reload <id>`.                                                                                                           |
| A timeline item shows "Plugin timeline item unavailable" | No renderer matches its `kind` and `version`, the renderer schema rejected `data`, or the plugin is not running on that host.                                    |
| A transformer has no effect                              | `query.itemType` does not match the source item, the transform returned `undefined`, or it threw. The app console shows `[Plugins] Timeline transformer failed`. |
| A slash command is not offered                           | Its name collides with a built-in or another plugin, its context is `agent` in a draft, or the composer has attachments.                                         |
| A client registration is "not a function"                | The app is older than the API. Update the app, or raise `requirements.paseo`.                                                                                    |
