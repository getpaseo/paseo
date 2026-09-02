---
name: paseo-plugin
description: Build and manage trusted local Paseo plugins.
---

# Paseo plugins

Build or manage the requested plugin directly. Read `docs/plugins.md`, the current public plugin
quickstart and reference, and the closest `plugin-examples/` project before changing code.

## Trust and target daemon

Plugins are trusted, unsandboxed code. Server code can access files, processes, credentials, and
network services on the daemon machine. Client code runs inside Paseo apps. Inspect the target
daemon's root `pluginsEnabled` value before installation. If it is false or absent, obtain explicit
permission before enabling it. Never edit a remote daemon's local config.

## Project shape

```text
my-plugin/
  paseo-plugin.json
  package.json
  tsconfig.json
  index.client.tsx       # optional client entry
  index.server.ts        # optional server entry
  client/main.tsx        # React Native components and callbacks
  server/main.ts         # handlers, Node APIs, credentials
  shared/contracts.ts    # Zod contracts and plain values
```

At least one entry is required. Both entries accept `.ts` or `.tsx`. The entry is the runtime
boundary. `client/` and `*.client.*` are client-only; `server/` and `*.server.*` are server-only;
`shared/` and `*.shared.*` work in both. Never import `node:` modules from client code.

## Contexts

Default-export a contribution function from each present entry and return cleanup.

```ts
// index.server.ts
import type { PluginServerContext } from "@getpaseo/plugin";
export default function contribute(server: PluginServerContext) {
  server.handle(contract, handler);
  return () => {};
}
```

```tsx
// index.client.tsx
import type { PluginClientContext } from "@getpaseo/plugin";
export default function contribute(client: PluginClientContext) {
  const remove = client.addSurface("main", MainSurface);
  return () => remove();
}
```

Client registration methods are `addSurface`, `addSidebarItem`, `addWorkspacePanel`,
`addCommandCenterItem`, `addSlashCommand`, `addComposerPill`, `addAttachmentSource`, `addTheme`,
`addTimelineTransformer`, and `addTimelineRenderer`. Every one returns an idempotent remover.
The context also exposes `paseo`, typed `rpc`, `openSurface`, and explicit-context `openPanel`.

Put every component and client callback in the client runtime. Put RPC handlers and machine-local
work in the server runtime. Define shared RPC and attachment contracts with
`@getpaseo/plugin/server` and Zod.

Surfaces and panels use React Native primitives on desktop, browser, iOS, and Android. Color every
`Text` from `theme.colors`, use `theme.colors.surface0` for roots, and use `layout.compact` for
layout. Read cached state with `useWorkspace(id, selector)` and `useAgent(id, selector)`. Use
`usePaseo()` for normal Paseo operations; use plugin RPC only for plugin-specific daemon behavior.

## Workflows

Create and install:

```bash
paseo plugin init /absolute/path/to/plugin
cd /absolute/path/to/plugin
npm install
npm run typecheck
paseo plugin install /absolute/path/to/plugin
paseo plugin ls
```

After source edits:

```bash
npm run typecheck
paseo plugin reload my-plugin
paseo plugin ls
paseo plugin logs my-plugin
```

Require `running` with no error. Exercise the changed surface, callback, or RPC on the intended
host. Check wide and compact layouts and a light and dark theme for UI changes. Do not restart the
daemon to reload source.

Use `paseo plugin disable`, `enable`, and `remove` for lifecycle changes. Removal deletes plugin
configuration, not a directory source. When a plugin fails, inspect `paseo plugin ls` and
`paseo plugin logs <id>`, fix the source, typecheck, and reload.

For an old mixed entry, follow `public-docs/plugins/migration.md` mechanically.
