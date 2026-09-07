---
title: Plugin quickstart
description: Build, install, share, and update a trusted Paseo plugin.
nav: Paseo v0.7 — Current
order: 45
category: Plugins
---

# Plugin quickstart

> **For Paseo v0.7.x.** This is the current stable plugin API.

> **Experimental:** The plugin API is still evolving, so expect breaking changes and updates to
> your plugins as Paseo evolves.

See the [plugin roadmap](https://github.com/getpaseo/paseo/labels/plugins) for planned contribution
surfaces and their current status.

Paseo plugins add native workspace panels, composer pills, Command Center items, global surfaces, app themes, daemon behavior, and composer attachment sources. They run on every Paseo client connected to the host, including mobile.

> **Trust every plugin you add.** `paseo plugin add` and `paseo plugin install` mean “I trust this codebase.” Server code and Git preparation commands run unsandboxed with the daemon user's access on the daemon host; client contributions run inside Paseo. Dependencies and future updates are part of that decision. With `--host`, commands run on the remote daemon host.

On the target host, open **Settings → Plugins** and turn on **Enable plugins**. This is the global switch for every configured plugin on that daemon.

You can also change the root `pluginsEnabled` field in the daemon's `config.json`, then apply it without restarting:

```bash
paseo reload --json
```

Enabling starts configured plugins; disabling tears them down. Automation must inspect the current value first and obtain your explicit permission before changing a disabled or omitted value to `true`.

## Create a plugin

Use an absolute path on the daemon machine:

```bash
paseo plugin init /absolute/path/to/workspace-plugin
cd /absolute/path/to/workspace-plugin
npm install
```

`init` creates a strict TypeScript project. It does not run the package manager. `npm install`
installs development dependencies for local typechecking and tests. Paseo supplies the plugin SDK,
React, React Native, TanStack Query, and Zod at runtime; plugins do not need a `build` hook for these
modules. `index.ts` registers contributions; client UI lives in `*.client.tsx` files.

Plugins run on desktop, browser, iOS, and Android. Paseo ships several themes. Color every `Text` from `theme.colors.foreground` or `theme.colors.foregroundMuted`, and size layout from `layout.compact`. Hardcoded black text fails in dark themes.

Replace `main.client.tsx` with:

```tsx
import { type PluginWorkspacePanelProps, useWorkspace } from "@getpaseo/plugin";
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

Replace `index.ts` with:

```ts
import type { PluginContext } from "@getpaseo/plugin";
import { WorkspaceOverview } from "./main.client";

export default function contribute(plugin: PluginContext) {
  plugin.addWorkspacePanel({
    id: "overview",
    title: "Workspace overview",
    icon: "PanelsTopLeft",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: WorkspaceOverview,
  });
  plugin.addCommandCenterItem({
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

The icon is a [Lucide](https://lucide.dev/icons/) icon name. `*.client.tsx` files can use React Native runtime APIs; Paseo excludes them from the daemon bundle. Panel props contain stable IDs; `useWorkspace` selects the cached fields the component needs without fetching through RPC or re-rendering for unrelated workspace changes. See [Theme and layout](/docs/plugins/v0.7/reference#theme-and-layout) for the required tokens.

## Check and install it

```bash
npm run typecheck
paseo plugin install /absolute/path/to/workspace-plugin
paseo plugin ls
```

Open a workspace, press **⌘K** on macOS or **Ctrl+K** on Windows and Linux, and choose **Open workspace overview**. It opens as a normal workspace tab. If the item does not appear, confirm that **Enable plugins** is on, the plugin status is `running` in `paseo plugin ls`, and the client is viewing the host where you installed it.

To install a plugin published through GitHub or another Git host:

```bash
paseo plugin add owner/repository
paseo plugin add https://gitlab.com/group/repository.git
paseo plugin add https://git.example.com/owner/repository.git
paseo plugin add owner/monorepo:plugins/workspace
paseo plugin add owner/repository --ref main
```

Append `:relative/path` to the source when the plugin lives below the repository root.

An omitted `--ref` tracks the default branch. Explicit branches track updates; tags and commits are
pinned. Apply updates with:

```bash
paseo plugin update workspace-plugin
paseo plugin update --all
```

Most plugins should omit `build`. Paseo compiles TypeScript and TSX and supplies its runtime modules.
Declare preparation only when the staged checkout must install another dependency, generate source,
or perform another required build step:

```json
{
  "id": "workspace-plugin",
  "build": [
    ["npm", "ci"],
    ["npm", "run", "build"]
  ]
}
```

Each `build` entry is a non-empty argv array, executed directly without a shell from the staged
plugin directory. Paseo never chooses a package manager or infers commands from lockfiles. On
install and update it resolves the exact commit, runs these commands, then validates, compiles, and
activates the candidate. A failed command discards the candidate and keeps the installed/running
version. The daemon log records the exact argv and output; `--host` runs them on the remote daemon
host.

## Edit and reload

Source changes are explicit:

```bash
npm run typecheck
paseo plugin reload workspace-plugin
```

A reload stops the old plugin, runs its cleanup, compiles the current source, and starts it again. A failed reload stays failed and reports its load error; fix the source and reload again.

## Debug backend output

Use normal Node logging in daemon-side handlers and cleanup:

```ts
console.log("Refreshing issues");
console.error("Issue refresh failed", error);
```

Read recent stdout and stderr from **Settings → Plugins → Logs** or the CLI:

```bash
paseo plugin logs workspace-plugin
paseo plugin logs workspace-plugin --json
```

The log tail includes `[paseo]` loading, ready, stopping, and stopped entries, plus compilation and
load failures. It survives reloads and crashes. Inspect it when a plugin fails to start or an RPC
rejects. See [Debug backend output](/docs/plugins/v0.7/reference#debug-backend-output) for retention and
security behavior.

## Next

- [Plugin reference](/docs/plugins/v0.7/reference), add daemon behavior, use the Paseo SDK, contribute themes and attachments, and manage lifecycle.
- [TypeScript SDK](/docs/sdk), the workspace, agent, provider, and config API exposed inside plugins.
