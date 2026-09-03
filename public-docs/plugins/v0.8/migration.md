---
title: Migrate a plugin to runtime entries
description: Mechanical migration from a mixed plugin entry to explicit client and server entries.
nav: Migration
order: 48
category: Plugins
---

# Migrate a plugin to runtime entries

> **For the upcoming Paseo v0.8 release.** This migration is not required for Paseo v0.7.

Give this page to a coding agent with the plugin directory as its working directory. Execute the
steps in order. Do not keep a compatibility entry.

## 1. Classify the existing code

Start from the old shape:

```text
my-plugin/
  paseo-plugin.json
  package.json
  tsconfig.json
  index.ts
  greeting.client.tsx
  greeting.server.ts
  greeting.shared.ts
```

The finished shape is:

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

Create only the entries the plugin needs. At least one is required. Components and client callbacks
need the client entry. RPC handlers and Node APIs need the server entry.

## 2. Rename files and directories

Apply these rules exactly:

1. Replace the mixed root entry with `index.client.tsx`, `index.server.ts`, or both.
2. Move every `name.client.ts` or `name.client.tsx` to `client/name.ts` or `client/name.tsx`.
3. Move every `name.server.ts` or `name.server.tsx` to `server/name.ts` or `server/name.tsx`.
4. Move every `name.shared.ts` or `name.shared.tsx` to `shared/name.ts` or `shared/name.tsx`.
5. Preserve nested feature directories under the matching runtime directory.
6. Update relative imports after every move.
7. Keep `paseo-plugin.json`, `package.json`, and `tsconfig.json` at the root.
8. Delete the old root entry. Paseo does not load it.

The directories are the compiler boundaries. A file beneath `client/` compiles only into the app
bundle, a file beneath `server/` only into the daemon bundle, and `shared/` into both. Filename
suffixes such as `*.client.tsx` no longer mean anything, and a code module left at the plugin root
is a compile error.

## 3. Move every registration

Use this table as the complete registration checklist.

| Old registration and location                                                                 | New registration and location                                                              |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `plugin.handle(contract, handler)` in the old root entry                                      | `server.handle(contract, handler)` in `index.server.ts`                                    |
| `plugin.addSurface(id, Component)` in the old root entry                                      | `client.addSurface(id, Component)` in `index.client.tsx`                                   |
| `plugin.addSidebarItem(item)` in the old root entry                                           | `client.addSidebarItem(item)` in `index.client.tsx`                                        |
| `plugin.addWorkspacePanel(panel)` in the old root entry                                       | `client.addWorkspacePanel(panel)` in `index.client.tsx`                                    |
| `plugin.addCommandCenterItem(item)` in the old root entry                                     | `client.addCommandCenterItem(item)` in `index.client.tsx`                                  |
| `plugin.addClientSlashCommand(command)` in the old root entry                                 | `client.addSlashCommand(command)` in `index.client.tsx`                                    |
| `plugin.addClientSide(fn)` in the old root entry                                              | Delete the wrapper and move the body of `fn` into the default client entry function        |
| `client.addComposerPill(pill)` inside the old client callback                                 | `client.addComposerPill(pill)` inside `index.client.tsx` or an imported `client/` function |
| `plugin.addAttachmentSource(source)` in the old root entry                                    | `client.addAttachmentSource(source)` in `index.client.tsx`                                 |
| `plugin.addTheme(theme)` in the old root entry                                                | `client.addTheme(theme)` in `index.client.tsx`                                             |
| `plugin.addTimelineTransformer(transformer)` in the old root entry                            | `client.addTimelineTransformer(transformer)` in `index.client.tsx`                         |
| `plugin.addTimelineRenderer(renderer)` in the old root entry                                  | `client.addTimelineRenderer(renderer)` in `index.client.tsx`                               |
| `import { defineRpc, defineAttachmentSource } from "@getpaseo/plugin/server"` in shared files | `import { defineRpc, defineAttachmentSource } from "@getpaseo/plugin"`                     |
| `ZodOutput<typeof contract.input>` handler parameter types                                    | `RpcInput<typeof contract>` from `@getpaseo/plugin`; `RpcOutput` for return types          |

Import `PluginClientContext` in the client entry and `PluginServerContext` in the server entry.
Remove imports of the old context type. `@getpaseo/plugin/server` now exports only handler-side
types such as `PluginHandlerContext`. Every client `add*` now returns an idempotent removal
function. Preserve any remover the plugin calls before teardown; Paseo removes outstanding
registrations after the entry cleanup runs.

## 4. Separate imports

The client entry imports only `client/`, `shared/`, and client-safe packages. The server entry imports
only `server/`, `shared/`, and server-safe packages. A `node:` import in the client entry or anything
reachable from it is a compile error. Never import a component into the server entry merely to wire
its registration; that registration belongs in the client entry.

## 5. Recognize half-migration errors

| Compiler or load error                                                                                                     | Meaning and fix                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `Plugin entry split is required`                                                                                           | The directory still has only the old root entry. Create a runtime entry, move registrations, then delete the old file.    |
| `Plugin entry points are missing: expected index.client.ts or index.client.tsx and/or index.server.ts or index.server.tsx` | No supported entry exists. Add at least one exact filename.                                                               |
| `server-only module cannot be imported into the plugin client bundle: <file>`                                              | A client import reaches `server/`. Move the call behind an RPC and import its contract from `shared/`.                    |
| `client-only module cannot be imported into the plugin server bundle: <file>`                                              | A server import reaches `client/`. Move that registration and import to the client entry.                                 |
| `Plugin modules belong in client/, server/, or shared/: <file>`                                                            | A code module is still at the plugin root. Move it into the matching directory and fix its imports.                       |
| `Node module cannot be imported into the plugin client bundle: node:<name> imported by <file>`                             | Client code imports a Node API. Move the operation to `server/`, expose an RPC in `shared/`, and call it from the client. |
| TypeScript reports that `PluginContext`, `addClientSide`, or `addClientSlashCommand` does not exist                        | Replace the old context types and registrations using the table above.                                                    |

## 6. Worked example: `plugin-examples/local-plugin`

Only the entry files and import paths change. Component and handler bodies move without edits.

Before:

```text
local-plugin/
  index.ts
  main.client.tsx
  increment.server.ts
  increment.shared.ts
```

```ts
// index.ts
import type { PluginContext } from "@getpaseo/plugin";
import { contributeClient, ExamplePanel } from "./main.client";
import { increment } from "./increment.server";
import { incrementRpc } from "./increment.shared";

export default function contribute(plugin: PluginContext) {
  plugin.handle(incrementRpc, increment);
  plugin.addWorkspacePanel({
    id: "counter",
    title: "Plugin counter",
    icon: "Blocks",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: ExamplePanel,
  });
  plugin.addCommandCenterItem({
    id: "open-counter",
    title: "Open plugin counter",
    icon: "Blocks",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("counter");
    },
  });
  plugin.addClientSide(contributeClient);
  return () => {};
}
```

After:

```text
local-plugin/
  index.client.tsx
  index.server.ts
  client/main.tsx        # was main.client.tsx
  server/increment.ts    # was increment.server.ts
  shared/increment.ts    # was increment.shared.ts
```

```tsx
// index.client.tsx
import type { PluginClientContext } from "@getpaseo/plugin";
import { contributeClient, ExamplePanel } from "./client/main";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "counter",
    title: "Plugin counter",
    icon: "Blocks",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: ExamplePanel,
  });
  client.addCommandCenterItem({
    id: "open-counter",
    title: "Open plugin counter",
    icon: "Blocks",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("counter");
    },
  });
  return contributeClient(client);
}
```

```ts
// index.server.ts
import type { PluginServerContext } from "@getpaseo/plugin";
import { increment } from "./server/increment";
import { incrementRpc } from "./shared/increment";

export default function contribute(server: PluginServerContext) {
  server.handle(incrementRpc, increment);
  return () => {};
}
```

Import path changes inside the moved files:

```diff
 // client/main.tsx
-import { incrementRpc } from "./increment.shared";
+import { incrementRpc } from "../shared/increment";

 // server/increment.ts
-import { incrementRpc } from "./increment.shared";
+import { incrementRpc } from "../shared/increment";
```

`contributeClient` already took a `PluginClientContext` and returned cleanup, so the client entry
calls it directly and returns its cleanup. A plugin whose `addClientSide` callback also registered
pills or subscriptions keeps that code; only the wrapper goes away.

## 7. Verify the migration

Run:

```bash
npm run typecheck
paseo plugin reload <plugin-id>
paseo plugin ls
```

Require `running` with no error. Exercise every contribution. For plugins with RPCs, call the client
action and verify the server result. For client-only plugins, confirm the contribution loads without
a server process. Call any stored registration remover twice and verify the second call is a no-op.
