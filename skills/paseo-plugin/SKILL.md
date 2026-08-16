---
name: paseo-plugin
description: Build and manage trusted local Paseo plugins. Use when the user asks to create, edit, install, reload, enable, disable, or remove a Paseo plugin.
user-invocable: true
---

# Paseo plugins

Start by scaffolding a strict, typecheckable TSX project:

```bash
paseo plugin init /absolute/path/to/my-plugin
cd /absolute/path/to/my-plugin
npm install
```

The generated directory contains `paseo-plugin.json`, `index.tsx`, `paseo-plugin.d.ts`,
`package.json`, and `tsconfig.json`. The manifest contains one default ID:

```json
{ "id": "my-plugin" }
```

Default-export one contribution function from `index.tsx`. Use `@paseo/plugin` and the host-provided React, React Native, TanStack Query, and Zod dependencies. The function must return cleanup for resources created by plugin code, even when it has nothing to clean up:

```tsx
import type { PluginContext } from "@paseo/plugin";
import React from "react";
import { Text } from "react-native";

function MainSurface() {
  return <Text>Hello from my plugin</Text>;
}

export default function contribute(plugin: PluginContext) {
  plugin.addSurface("main", MainSurface);
  return () => undefined;
}
```

Manage the plugin through the daemon CLI:

```bash
paseo plugin install /absolute/path/to/plugin
paseo plugin install /absolute/path/to/plugin --id another-runtime-id
paseo plugin reload my-plugin
paseo plugin ls
paseo plugin disable my-plugin
paseo plugin enable my-plugin
paseo plugin remove my-plugin
```

After source edits, reload explicitly and use the reported load error to correct the plugin. Use `enable`, `disable`, and `remove` for recovery. Never edit `$PASEO_HOME/config.json` directly. Plugins are trusted code and run without sandboxing.

Run `npm run typecheck` before every install or reload. The installed packages and local SDK
declarations exist only for static checking; Paseo provides the runtime modules.
