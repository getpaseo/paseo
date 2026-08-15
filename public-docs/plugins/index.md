---
title: Plugin quickstart
description: Build, install, and reload a trusted local Paseo plugin with a native sidebar surface.
nav: Quickstart
order: 45
category: Plugins
---

# Plugin quickstart

Paseo plugins add native surfaces, sidebar items, daemon behavior, and composer attachment sources. They run on every Paseo client connected to the host, including mobile.

Plugins are trusted local code. Install only code you trust: backend code runs unsandboxed with access to the daemon machine, and client contributions run inside the Paseo app.

On the target host, open **Settings → Plugins** and turn on **Enable plugins**. This is the global switch for every configured plugin on that daemon.

You can also change the root `pluginsEnabled` field in the daemon's `config.json`, then apply it without restarting:

```bash
paseo reload --json
```

Enabling starts configured plugins; disabling tears them down. Automation must inspect the current value first and obtain your explicit permission before changing a disabled or omitted value to `true`.

## Create a plugin

Use an absolute path on the daemon machine:

```bash
paseo plugin init /absolute/path/to/counter-plugin
cd /absolute/path/to/counter-plugin
npm install
```

`init` creates a strict TSX project. It does not run the package manager.

Replace `index.tsx` with:

```tsx
import type { PluginContext } from "@paseo/plugin";
import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";

function Counter() {
  const [count, setCount] = useState(0);

  return (
    <View style={{ flex: 1, padding: 24, gap: 16 }}>
      <Text style={{ fontSize: 48 }}>{count}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Increment counter, currently ${count}`}
        onPress={() => setCount((value) => value + 1)}
        style={{ padding: 16, borderRadius: 12, backgroundColor: "#238253" }}
      >
        <Text style={{ color: "white", textAlign: "center" }}>Count me in</Text>
      </Pressable>
    </View>
  );
}

export default function contribute(plugin: PluginContext) {
  plugin.addSurface("main", Counter);
  plugin.addSidebarItem({
    id: "main",
    title: "Counter",
    icon: "ListPlus",
    surface: "main",
  });
  return () => undefined;
}
```

The icon is a [Lucide](https://lucide.dev/icons/) icon name. The surface uses React Native primitives, so the same contribution works in the desktop, browser, iOS, and Android clients.

## Check and install it

```bash
npm run typecheck
paseo plugin install /absolute/path/to/counter-plugin
paseo plugin ls
```

Open **Counter** in the Paseo sidebar. If the item does not appear, confirm that **Enable plugins** is on, the plugin status is `running` in `paseo plugin ls`, and the client is viewing the host where you installed it.

## Edit and reload

Source changes are explicit:

```bash
npm run typecheck
paseo plugin reload counter-plugin
```

A reload stops the old plugin, runs its cleanup, compiles the current source, and starts it again. A failed reload stays failed and reports its load error; fix the source and reload again.

## Next

- [Plugin reference](/docs/plugins/reference), add daemon behavior, use the Paseo SDK, contribute attachments, and manage lifecycle.
- [TypeScript SDK](/docs/sdk), the workspace, agent, provider, and config API exposed inside plugins.
