---
title: Plugin quickstart
description: Build, install, share, and update a trusted Paseo plugin.
nav: Paseo v0.8 — Beta
order: 46
category: Plugins
---

# Plugin quickstart

> **For Paseo v0.8 beta.** Use the [v0.7 docs](/docs/plugins/v0.7)
> if you run the stable release.

> **Experimental:** The plugin API is still evolving, so expect breaking changes and updates to
> your plugins as Paseo evolves. See the [plugin roadmap](https://github.com/getpaseo/paseo/labels/plugins)
> for planned contribution surfaces.

A plugin is a TypeScript project installed into one Paseo daemon. It can add
[surfaces and sidebar items](/docs/plugins/v0.8/reference#surfaces-and-sidebar-items),
[workspace panels](/docs/plugins/v0.8/reference#workspace-panels),
[Command Center items](/docs/plugins/v0.8/reference#command-center-items),
[slash commands](/docs/plugins/v0.8/reference#slash-commands),
[composer pills](/docs/plugins/v0.8/reference#composer-pills),
[timeline items](/docs/plugins/v0.8/reference#timeline-items),
[themes](/docs/plugins/v0.8/reference#contribute-a-theme),
[attachment sources](/docs/plugins/v0.8/reference#add-a-composer-attachment-source), and
[daemon-side RPCs](/docs/plugins/v0.8/reference#add-plugin-specific-backend-behavior). It can also
[connect a coding agent as a provider](/docs/plugins/v0.8/providers). Client
contributions run on every Paseo client connected to that daemon, including mobile.

This guide scaffolds a plugin, runs it, and adds a workspace panel to it.

## Create a plugin

Use an absolute path on the daemon machine:

```bash
paseo plugin init /absolute/path/to/workspace-plugin
cd /absolute/path/to/workspace-plugin
npm install
```

`init` writes a strict TypeScript project and does not run the package manager. `npm install` adds
development dependencies for typechecking and tests only; Paseo supplies the plugin SDK, React,
React Native, TanStack Query, and Zod at runtime.

The scaffold is a working plugin: a sidebar surface with a button that asks the daemon for a
greeting through an RPC.

```text
workspace-plugin/
  paseo-plugin.json      # plugin ID and supported Paseo versions
  index.client.tsx       # runs in the Paseo app
  index.server.ts        # runs in a daemon subprocess
  client/greeting.tsx    # the surface component
  client/web.ts          # the only file allowed to touch browser APIs
  server/greeting.ts     # the RPC handler
  shared/greeting.ts     # the RPC contract, imported by both
  package.json
  tsconfig.json
```

Each entry default-exports one function that registers contributions and returns a cleanup
function. `index.client.tsx` registers the surface and the sidebar item that opens it:

```tsx
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { GreetingSurface } from "./client/greeting";

export default function contribute(client: PluginClientContext) {
  client.addSurface("greeting", GreetingSurface);
  client.addSidebarItem({
    id: "greeting",
    title: "Greeting",
    icon: "MessageCircle",
    surface: "greeting",
  });
  return () => {};
}
```

`index.server.ts` registers the handler for the contract in `shared/greeting.ts`:

```ts
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createGreeting } from "./server/greeting";
import { greetingRpc } from "./shared/greeting";

export default function contribute(server: PluginServerContext) {
  server.handle(greetingRpc, createGreeting);
  return () => {};
}
```

The directory is the boundary. Code under `client/` compiles only into the app bundle, code under
`server/` only into the daemon bundle, and `shared/` into both. Importing across that line, adding
a code file at the root, or importing a `node:` module from client code is a compile error. A
plugin with no daemon-side work can omit `index.server.ts`; a plugin with no UI can omit
`index.client.tsx`.

Client code runs on phones as well as in browsers. The project typechecks without the DOM library,
so `document` and `window` are errors outside `client/web.ts`, which shows how to gate a browser
API behind `Platform.OS` with a native fallback. See
[Cross-platform rules](/docs/plugins/v0.8/reference#cross-platform-rules) before writing UI.

## Install and try it

Plugins are trusted, unsandboxed code: server code and Git preparation commands run with the daemon
user's access on the daemon machine, and client code runs inside the Paseo app. Installing a plugin
means you trust that codebase, its dependencies, and its future updates.

Turn on **Enable plugins** under **Settings → Plugins** on the daemon you are installing into. It is
the global switch for every plugin on that daemon. It is also the root `pluginsEnabled` field in the
daemon's `config.json`; after editing the file, apply it with `paseo reload --json`. An automated
tool must read the current value and get your explicit permission before turning it on.

Then typecheck and install:

```bash
npm run typecheck
paseo plugin install /absolute/path/to/workspace-plugin
paseo plugin ls
```

`paseo plugin ls` should report the plugin as `running`. Open Paseo, choose **Greeting** in the
sidebar, and press **Create greeting**. The message comes back from the daemon subprocess through
the RPC.

If the sidebar item is missing, check that **Enable plugins** is on, the plugin is `running`, and
the client is viewing the host you installed into. `paseo plugin logs workspace-plugin` shows the
daemon-side output, including load errors.

## Add a workspace panel

A workspace panel opens as a tab next to agents, terminals, and files. Create `client/overview.tsx`:

```tsx
import { type PluginWorkspacePanelProps, useWorkspace } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";

export function WorkspaceOverview({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(workspaceId, ({ name, directory }) => ({
    name,
    directory,
  }));
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        gap: layout.compact ? 8 : 12,
        backgroundColor: theme.colors.surface0,
      },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24 },
      label: { color: theme.colors.foregroundMuted },
      detail: { color: theme.colors.foreground },
    }),
    [theme, layout.compact],
  );

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{workspace?.name}</Text>
      <Text style={styles.label}>Directory</Text>
      <Text style={styles.detail}>{workspace?.directory}</Text>
    </View>
  );
}
```

`useWorkspace` reads the fields the panel renders from the app's cached state, without an RPC and
without re-rendering when unrelated fields change. Every `Text` takes its color from
`theme.colors`, and `layout.compact` drives spacing, so the panel works in every Paseo theme and on
phones. See [Theme and layout](/docs/plugins/v0.8/reference#theme-and-layout) for the token list.

Register the panel and a Command Center item that opens it by adding to `index.client.tsx`:

```tsx
import { WorkspaceOverview } from "./client/overview";

// Inside contribute(client), after the existing registrations:
client.addWorkspacePanel({
  id: "overview",
  title: "Workspace overview",
  icon: "PanelsTopLeft",
  context: "workspace",
  locations: ["workspace", "explorer"],
  Component: WorkspaceOverview,
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
```

`icon` is a [Lucide](https://lucide.dev/icons/) icon name.

## Edit and reload

Source changes take effect only when you reload the plugin:

```bash
npm run typecheck
paseo plugin reload workspace-plugin
```

A reload stops the old plugin, runs its cleanup, compiles the current source, and starts it again.
A failed reload stays failed and reports its error in `paseo plugin ls`; fix the source and reload
again.

Open a workspace, press **⌘K** on macOS or **Ctrl+K** on Windows and Linux, and choose **Open
workspace overview**. The panel opens as a workspace tab.

## Install a published plugin

Plugins published in a Git repository install by shorthand or URL:

```bash
paseo plugin add owner/repository
paseo plugin add https://gitlab.com/group/repository.git
paseo plugin add owner/monorepo:plugins/workspace
paseo plugin add owner/repository --ref main
```

Append `:relative/path` when the plugin lives below the repository root. Without `--ref`, the
default branch is tracked; a branch tracks updates, while a tag or commit stays pinned.

```bash
paseo plugin ls
paseo plugin update workspace-plugin
paseo plugin update --all
```

`ls` reports runtime state, source details, and the installed commit without contacting the remote.

Paseo compiles TypeScript itself, so most plugins need no build step. A repository that must
install a dependency Paseo does not provide, or generate files, declares
[`build` commands](/docs/plugins/v0.8/reference#cli-reference) in its manifest.

## Read backend logs

Daemon-side handlers and cleanup can use normal Node logging:

```ts
console.log("Refreshing issues");
console.error("Issue refresh failed", error);
```

Read the recent output from **Settings → Plugins → Logs** or the CLI:

```bash
paseo plugin logs workspace-plugin
paseo plugin logs workspace-plugin --json
```

The tail includes `[paseo]` loading, ready, stopping, and stopped entries, plus compilation and load
failures, and it survives reloads and crashes. Client-side output stays in the app. See
[Debug backend output](/docs/plugins/v0.8/reference#debug-backend-output) for retention and what not to
log.

## Next

- [Build a provider plugin](/docs/plugins/v0.8/providers): connect an agent directly or through ACP,
  render provider-owned timeline items, test it, and publish it.
- [Plugin reference](/docs/plugins/v0.8/reference): every contribution type, its fields, the runtime
  modules, hosts, and the CLI.
- [Migrate a plugin to runtime entries](/docs/plugins/v0.8/migration): move a plugin written against the
  single `index.ts` entry, step by step.
- [TypeScript SDK](/docs/sdk): the workspace, agent, provider, and config API available as `paseo`
  in client and server code.
