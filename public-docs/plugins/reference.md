---
title: Plugin reference
description: Local plugin files, contributions, Paseo SDK access, RPCs, attachments, lifecycle, hosts, and CLI commands.
nav: Reference
order: 46
category: Plugins
---

# Plugin reference

Local plugins are directory sources installed into one Paseo daemon. A plugin can contribute:

- React Native surfaces and sidebar items to Paseo clients;
- schema-validated RPC handlers running beside the daemon;
- normal Paseo operations through the TypeScript SDK;
- searchable external resources in the message composer.

Plugin code is trusted and unsandboxed. Client surfaces run in the Paseo app. Backend contributions run in a subprocess with access to the daemon machine, including its files, processes, credentials, and network.

## Project files

`paseo plugin init /absolute/path/to/my-plugin` creates:

```text
my-plugin/
  paseo-plugin.json
  index.tsx
  paseo-plugin.d.ts
  package.json
  tsconfig.json
```

The manifest contains the default plugin ID:

```json
{ "id": "my-plugin" }
```

Plugin, surface, sidebar-item, and attachment-source IDs start with a lowercase letter and contain lowercase letters, numbers, or hyphens.

The generated declaration file supplies `@paseo/plugin` types for local typechecking. Paseo supplies the runtime modules. Regenerate a fresh project with the matching CLI when the plugin contract changes.

## Entry point and cleanup

`index.tsx` default-exports one contribution function. It must return cleanup, even when it has nothing to clean:

```tsx
import type { PluginContext } from "@paseo/plugin";

export default function contribute(plugin: PluginContext) {
  // Register contributions here.
  return () => undefined;
}
```

Cleanup can be async. Release timers, watchers, sockets, and other resources created by the plugin. Paseo also removes registrations, unmounts surfaces, rejects pending RPCs, closes the plugin's daemon session, and stops its subprocess on reload, disable, removal, disconnect, or daemon shutdown.

## Surfaces and sidebar items

Register a component, then point a sidebar item at its surface ID:

```tsx
import type { PluginContext, PluginSurfaceProps } from "@paseo/plugin";
import { Text } from "react-native";

function Main({ host, layout }: PluginSurfaceProps) {
  return <Text>{`${host.label} · ${layout.platform}`}</Text>;
}

export default function contribute(plugin: PluginContext) {
  plugin.addSurface("main", Main);
  plugin.addSidebarItem({
    id: "main",
    title: "My plugin",
    icon: "Blocks",
    surface: "main",
  });
  return () => undefined;
}
```

`PluginSurfaceProps` contains:

| Field    | Meaning                                                   |
| -------- | --------------------------------------------------------- |
| `theme`  | Paseo theme values. Validate the keys your surface reads. |
| `host`   | Selected host `id` and display `label`.                   |
| `layout` | `compact` and the `ios`, `android`, or `web` platform.    |

Paseo owns the route, header, close action, host picker, error boundary, and query client. The plugin owns the surface body. Icons use [Lucide](https://lucide.dev/icons/) names.

Client code can import `react`, `react-native`, `@tanstack/react-query`, `zod`, and `@paseo/plugin`. Install them locally for typechecking; Paseo provides the client runtime instances.

## Use the Paseo SDK

Use `usePaseo()` for ordinary Paseo operations from a surface. It borrows the selected host's existing connection; do not create another client.

```tsx
import { usePaseo } from "@paseo/plugin";
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

```tsx
import { defineRpc, type PluginContext, useRpc } from "@paseo/plugin";
import { z } from "zod";

const greeting = defineRpc({
  name: "greeting.create",
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string() }),
});

function GreetingButton() {
  const createGreeting = useRpc(greeting);
  // Call createGreeting({ name: "Ada" }) from an event or query.
  return null;
}

export default function contribute(plugin: PluginContext) {
  plugin.handle(greeting, async ({ name }, { paseo }) => {
    const { config } = await paseo.config.get();
    return { message: `${name}: plugins are ${config.pluginsEnabled ? "on" : "off"}` };
  });
  plugin.addSurface("main", GreetingButton);
  return () => undefined;
}
```

Inputs and outputs are validated on both sides. RPC names start with a lowercase letter and contain lowercase letters, numbers, dots, hyphens, or underscores. `useRpc()` returns a typed async function. Use TanStack Query for request state, caching, and mutations.

Backend handlers receive the same `PaseoApi` as `{ paseo }`. Their connection belongs to the subprocess and closes when the plugin stops. Backend code can use Node APIs and dependencies installed in the plugin directory.

## Add a composer attachment source

An attachment source searches external resources and returns a stable text snapshot for an agent prompt. Keep credentials and vendor calls in the backend handler.

```tsx
import { defineAttachmentSource, defineRpc, type PluginContext } from "@paseo/plugin";
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

export default function contribute(plugin: PluginContext) {
  plugin.handle(searchIssues, ({ query }) => searchAcmeIssues(query));
  plugin.addAttachmentSource(issues);
  return () => undefined;
}
```

Paseo owns the composer menu, search picker, selected pill, draft state, and submission. The `text` value is the complete snapshot sent to the agent.

## Hosts and lifecycle

Plugins are installed per daemon. When the same contribution exists on several connected hosts, Paseo shows one sidebar item and adds a host picker. The selected host supplies the bundle, Paseo API, RPC transport, and query cache. Calls never fall through to another host when the selected host is offline.

Attachment sources remain scoped to each composer's host.

## CLI reference

```bash
paseo plugin init /absolute/path/to/plugin
paseo plugin install /absolute/path/to/plugin
paseo plugin install /absolute/path/to/plugin --id another-runtime-id
paseo plugin ls
paseo plugin reload my-plugin
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
| Reload fails                 | Fix the reported source error and reload again; Paseo does not restore the previous bundle.                                             |
