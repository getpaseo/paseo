---
name: paseo-plugin
description: Build and manage trusted local Paseo plugins. Use when the user asks to create, edit, install, reload, enable, disable, remove, or troubleshoot a Paseo plugin; add a native surface or sidebar item; use Paseo from plugin code; add plugin RPCs; or contribute composer attachments.
---

# Paseo plugins

Build or manage the requested plugin directly. Use the current public docs to catch contract changes, but keep working from this skill if the network is unavailable.

**User's request:** $ARGUMENTS

## Check current documentation

Fetch [https://paseo.sh/llms.txt](https://paseo.sh/llms.txt) first. Select and fetch the current plugin Markdown pages from that index before changing a plugin:

- [Plugin quickstart](https://paseo.sh/docs/plugins.md) ([browser page](https://paseo.sh/docs/plugins))
- [Plugin reference](https://paseo.sh/docs/plugins/reference.md) ([browser page](https://paseo.sh/docs/plugins/reference))

Use the deployed docs when they disagree with this skill. Do not send the user away to read them instead of completing the work.

When working in the Paseo repository, also read `docs/plugins.md` and the relevant example under `plugin-examples/`.

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
  index.tsx
  paseo-plugin.d.ts
  package.json
  tsconfig.json
```

The manifest supplies the default install ID:

```json
{ "id": "my-plugin" }
```

Default-export one contribution function. It must return cleanup, even when there is nothing to clean:

```tsx
import type { PluginContext } from "@paseo/plugin";

export default function contribute(plugin: PluginContext) {
  // Register contributions here.
  return () => undefined;
}
```

Cleanup can be async. Use it for timers, watchers, sockets, and other resources created by plugin code. Paseo removes registrations, unmounts surfaces, rejects pending RPCs, closes the plugin session, and stops the subprocess when the plugin stops.

## Add a sidebar surface

Plugin surfaces use React Native primitives and work across desktop, browser, iOS, and Android. Register the surface before its sidebar item:

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
      >
        <Text>Count me in</Text>
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

Icons are Lucide icon names. `PluginSurfaceProps` provides `theme`, selected `host`, and `layout`. Validate the theme keys the surface reads. Paseo owns the route, header, host picker, close action, error boundary, and per-installation query client.

Client code may import `react`, `react-native`, `@tanstack/react-query`, `zod`, and `@paseo/plugin`. Install dependencies locally for typechecking; Paseo supplies these runtime modules.

## Choose the correct API

Use the existing Paseo SDK for normal Paseo operations. Use plugin RPC only for plugin-specific backend behavior.

### Call Paseo from a surface

`usePaseo()` borrows the selected host's current connection. Never create another client inside a surface.

```tsx
import { usePaseo } from "@paseo/plugin";

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

  // Wire createReviewWorkspace to a Pressable.
  return null;
}
```

The API covers workspaces, agents, providers, and daemon config. It omits connection lifecycle because Paseo owns the connection. Consult the current [SDK reference](https://paseo.sh/docs/sdk/reference.md) for method details.

### Add daemon-side behavior

Define one Zod contract, register its subprocess handler, and call it with `useRpc()`:

```tsx
import { defineRpc, type PluginContext, useRpc } from "@paseo/plugin";
import { z } from "zod";

const greeting = defineRpc({
  name: "greeting.create",
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string() }),
});

function Greeting() {
  const createGreeting = useRpc(greeting);
  // Use createGreeting({ name: "Ada" }) in a query, mutation, or event.
  return null;
}

export default function contribute(plugin: PluginContext) {
  plugin.handle(greeting, async ({ name }, { paseo }) => {
    const { config } = await paseo.config.get();
    return { message: `${name}: plugins are ${config.pluginsEnabled ? "on" : "off"}` };
  });
  plugin.addSurface("main", Greeting);
  return () => undefined;
}
```

Inputs and outputs are validated on both sides. Backend handlers receive the same `PaseoApi` as `{ paseo }`; their IPC-backed daemon session lives exactly as long as the subprocess. Backend code can use Node APIs and installed dependencies. Keep credentials, filesystem access, shell commands, and vendor API calls in the handler rather than the client surface.

Use TanStack Query for async request state, caching, and mutations.

## Add a composer attachment source

Define a search RPC and register a declarative source:

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

Return complete text snapshots. Paseo owns the composer menu, picker, pills, drafts, and submission. Credentials and vendor calls stay in the daemon handler.

## Hosts and trust

Plugins are installed per daemon and are trusted, unsandboxed code. Backend code can access files, processes, credentials, and network services on the daemon machine. Client contributions run inside the Paseo app. Do not install a plugin the user has not authorized or source code you have not inspected.

### Check the global switch before installing

Identify the target daemon and inspect its root `pluginsEnabled` value in `config.json`. For the local daemon, `paseo daemon status --json` reports its `home`; the file is `<home>/config.json`. Treat a missing field as `false`. Do not infer the global value from a plugin's `disabled` status, because an individual plugin can also be disabled.

If `pluginsEnabled` is already `true`, continue without asking the user to enable it.

If it is false or absent, stop and ask the user for explicit permission before editing or enabling anything. Include this warning in the request:

> Plugins are trusted, unsandboxed code. Backend plugin code can access your daemon machine, including files, processes, credentials, and network services. Client plugin code runs inside the Paseo app. May I enable plugins on this daemon?

Do not continue unless the user agrees. After permission:

1. Preserve the rest of `config.json` and set the root `pluginsEnabled` field to `true`.
2. Run `paseo reload --json` against that daemon.
3. Require `pluginsEnabled` in `appliedPaths`, or accept an empty `appliedPaths` only after re-reading the file and confirming the live plugin catalog is enabled.
4. Run `paseo plugin ls` and verify the intended plugin reaches `running` after installation.

If the user asks to disable the global switch, set `pluginsEnabled` to `false`, run `paseo reload --json`, and verify configured plugins report `disabled`.

Do not edit a local config when the target is a remote daemon. Perform the edit on the daemon machine, or ask the user to use **Settings → Plugins → Enable plugins**. `paseo reload --host <url>` reloads the remote daemon's own file but does not edit it.

When the same sidebar contribution exists on several connected hosts, Paseo shows it once with a host picker. The selected host owns the bundle, SDK calls, RPCs, and query cache. An offline selected host does not fall through to another host. Attachment sources stay scoped to the composer's host.

## Typecheck and manage

Always typecheck before install or reload:

```bash
npm run typecheck
paseo plugin install /absolute/path/to/plugin
paseo plugin install /absolute/path/to/plugin --id another-runtime-id
paseo plugin ls
paseo plugin reload my-plugin
paseo plugin disable my-plugin
paseo plugin enable my-plugin
paseo plugin remove my-plugin
```

Use `--host <url>` when managing a daemon other than the CLI default. Plugin source edits require `paseo plugin reload`; config changes to the global switch require `paseo reload`. A failed plugin reload stays failed; inspect `paseo plugin ls`, fix the reported error, typecheck, and reload again. `remove` deletes configuration, never the source directory.

Do not restart the daemon to load source changes. Restarting it can kill the agent performing the work.

## Verify the outcome

After a change:

1. Run `npm run typecheck`.
2. Install or reload the exact runtime ID.
3. Run `paseo plugin ls` and require `running` with no error.
4. Confirm the contribution on the intended host. For UI work, check both a wide client and a compact/mobile client when available.
5. Exercise the changed action or RPC, including its error state.

Common failures:

- Missing sidebar item: wrong host, plugin not `running`, invalid Lucide icon, or sidebar item points to a missing surface.
- Unavailable client module: client bundles can use only the host-provided modules listed above.
- RPC rejection: input or output failed its Zod schema, or the handler threw.
- Stale UI: source was edited without `paseo plugin reload <id>`.
