---
title: Plugin quickstart
description: Build, install, and test a trusted Paseo plugin.
---

# Plugin quickstart

> **Experimental:** The plugin API is evolving and can make breaking changes.

Paseo plugins add native app contributions and daemon-side behavior. Trust every plugin you install:
server code and Git build commands run unsandboxed on the daemon host, and client code runs inside
every connected Paseo app.

## Create a plugin

Enable plugins in **Settings → Plugins**, then create a project with an absolute path:

```bash
paseo plugin init /absolute/path/to/greeting-plugin
cd /absolute/path/to/greeting-plugin
npm install
npm run typecheck
```

The scaffold has one explicit entry per runtime:

```text
greeting-plugin/
  paseo-plugin.json
  package.json
  tsconfig.json
  index.client.tsx
  index.server.ts
  client/greeting.tsx
  server/greeting.ts
  shared/greeting.ts
```

`shared/greeting.ts` defines a typed Zod RPC contract. `server/greeting.ts` handles it with access to
the daemon machine. `client/greeting.tsx` renders a React Native surface and calls it with `useRpc`.
The entries contain registration wiring only.

The client entry registers the surface and sidebar item:

```tsx
import type { PluginClientContext } from "@getpaseo/plugin";
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

The server entry registers the handler:

```ts
import type { PluginServerContext } from "@getpaseo/plugin";
import { createGreeting } from "./server/greeting";
import { greetingRpc } from "./shared/greeting";

export default function contribute(server: PluginServerContext) {
  server.handle(greetingRpc, createGreeting);
  return () => {};
}
```

The runtime boundary is the path. Client entries may import `client/` and `shared/`; server entries
may import `server/` and `shared/`. Cross-runtime imports fail compilation. `node:` modules are
rejected from client bundles.

## Install and check it

```bash
paseo plugin install /absolute/path/to/greeting-plugin
paseo plugin ls
```

Require the plugin to report `running`. Open **Greeting** in the sidebar and press **Create greeting**
to exercise the RPC. After edits, run `npm run typecheck` and `paseo plugin reload greeting-plugin`.

Every client `add*` returns an idempotent removal function. Client code may register contributions
later from subscriptions or RPC results. Paseo runs the entry cleanup and removes anything left when
the plugin stops or the host disconnects.

Continue with the [plugin reference](/docs/plugins/reference). Existing plugin authors should use
the standalone [runtime-entry migration guide](/docs/plugins/migration).
