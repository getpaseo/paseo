# Plugins

Paseo plugins are trusted TypeScript projects installed per daemon. Server code runs unsandboxed in
a subprocess on the daemon machine. Client code runs once per installation in every connected app.

## Project shape

Every plugin has one entry per runtime. At least one entry is required.

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

Both entries accept `.ts` or `.tsx`. Use `index.client.tsx` when the entry imports components. A
theme-only plugin can omit the server entry. A server-only plugin can omit the client entry and does
not publish client contributions.

Runtime ownership comes from the entry and module path:

| Path                                        | Runtime           |
| ------------------------------------------- | ----------------- |
| `index.client.tsx`, `client/`, `*.client.*` | App               |
| `index.server.ts`, `server/`, `*.server.*`  | Daemon subprocess |
| `shared/`, `*.shared.*`                     | Both              |

The compiler rejects imports across runtime boundaries. It also rejects every `node:` import in the
client bundle. Shared modules contain plain values and contracts; they do not import Node or React
Native runtime APIs.

A directory containing only the old root entry fails to load with a link to the
[migration guide](../public-docs/plugins/migration.md).

## Entry contracts

The server entry registers RPC handlers:

```ts
import type { PluginServerContext } from "@getpaseo/plugin";
import { createGreeting } from "./server/greeting";
import { greetingRpc } from "./shared/greeting";

export default function contribute(server: PluginServerContext) {
  server.handle(greetingRpc, createGreeting);
  return () => {};
}
```

The client entry registers every component and client callback:

```tsx
import type { PluginClientContext } from "@getpaseo/plugin";
import { Greeting } from "./client/greeting";

export default function contribute(client: PluginClientContext) {
  client.addSurface("greeting", Greeting);
  client.addSidebarItem({
    id: "greeting",
    title: "Greeting",
    icon: "MessageCircle",
    surface: "greeting",
  });
  return () => {};
}
```

`PluginClientContext` owns surfaces, sidebar items, workspace panels, Command Center items, slash
commands, composer pills, attachment sources, themes, timeline transformers, and timeline renderers.
It also exposes the selected host's `paseo` API, typed `rpc`, `openSurface`, and explicit-context
`openPanel`.

Every client `add*` returns an idempotent removal function. Registrations can be added during entry
setup or later from subscriptions and RPC results. The entry cleanup runs first during teardown;
Paseo then removes registrations that remain.

## RPCs

Put the Zod contract in `shared/`, the handler in `server/`, and callers in `client/`.

```ts
// shared/greeting.ts
import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

export const greetingRpc = defineRpc({
  name: "greeting.create",
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string() }),
});
```

The subprocess validates input and output. Handlers receive `{ paseo }`; keep credentials,
filesystem access, processes, and vendor requests there. Client components call contracts with
`useRpc` or `client.rpc`.

## Client contributions

- `addSurface` registers a cross-platform React Native surface.
- `addSidebarItem` points at a registered surface.
- `addWorkspacePanel` registers workspace- or agent-context panels.
- `addCommandCenterItem` registers a global, workspace, or agent action.
- `addSlashCommand` registers a workspace or agent composer command.
- `addComposerPill` registers a pill for an explicit workspace and agent.
- `addAttachmentSource` registers declarative attachment search backed by an RPC.
- `addTheme` contributes an app theme.
- `addTimelineTransformer` converts source timeline items to versioned plugin items.
- `addTimelineRenderer` validates and renders a versioned plugin item.

Components use React Native primitives. Color text and backgrounds from `theme.colors`, and use
`layout.compact` for phone and narrow-window layout. Use `useWorkspace(id, selector)` and
`useAgent(id, selector)` for cached host state. Use `usePaseo()` for ordinary Paseo operations and
plugin RPC only for plugin-specific daemon work.

## Lifecycle and installation

Plugin source changes require `paseo plugin reload <id>`. Config changes require `paseo reload`.
Do not restart the daemon to reload a plugin.

```bash
paseo plugin init /absolute/path/to/plugin
cd /absolute/path/to/plugin
npm install
npm run typecheck
paseo plugin install /absolute/path/to/plugin
paseo plugin ls
```

The global `pluginsEnabled` switch and the plugin's own enabled state must both be on. Installation
and Git build commands run with the daemon user's access. Logs from server initialization, handlers,
cleanup, and crashes are retained by the daemon and available through `paseo plugin logs <id>`.

When the same contribution exists on multiple connected hosts, the selected host owns its bundle,
RPC transport, SDK calls, query cache, and navigation. Calls do not fall through when that host is
offline. Attachment sources remain scoped to the composer's host.
