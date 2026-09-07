---
title: Plugin reference
description: Local plugin files, client and server runtimes, platform limits, contributions, RPCs, lifecycle, hosts, and CLI commands.
nav: Reference
order: 48
category: Plugins
---

# Plugin reference

> **For the upcoming Paseo v0.8 release.** Return to the [v0.8 quickstart](/docs/plugins/v0.8).

Migrating an existing plugin? Follow the standalone [runtime-entry migration guide](/docs/plugins/v0.8/migration).

Local plugins are directory sources installed into one Paseo daemon. A plugin can contribute:

- React Native surfaces and sidebar items to Paseo clients;
- workspace and agent panels opened as workspace tabs;
- global, workspace, and agent actions in the Command Center;
- slash commands in the message composer;
- transformed and daemon-pushed agent timeline rows;
- light and dark themes in Settings → Appearance;
- schema-validated RPC handlers running beside the daemon;
- normal Paseo operations through the TypeScript SDK;
- searchable external resources in the message composer.

Plugin code is trusted and unsandboxed. Client surfaces run in the Paseo app. Backend contributions run in a subprocess with access to the daemon machine, including its files, processes, credentials, and network.

## Project files

`paseo plugin init /absolute/path/to/my-plugin` creates:

```text
my-plugin/
  paseo-plugin.json
  index.client.tsx
  index.server.ts
  client/greeting.tsx
  server/greeting.ts
  shared/greeting.ts
  package.json
  tsconfig.json
```

The required root manifest is `paseo-plugin.json`. It contains the default plugin ID and supported Paseo versions:

```json
{ "id": "my-plugin", "requirements": { "paseo": ">=0.8.0" } }
```

### Requirements

`requirements` is an optional object. Its currently supported key, `paseo`, accepts an npm semver
range. An omitted `requirements.paseo` means `<0.8.0`: the plugin predates the first breaking
plugin release. Paseo 0.8 and later reject it with a link to the [migration guide](migration).
Empty strings, invalid ranges, and unknown manifest requirement keys are rejected.

| Range            | Compatible releases                                                 |
| ---------------- | ------------------------------------------------------------------- |
| `>=0.8.0`        | 0.8.0 and later stable releases, including future breaking releases |
| `^0.8.0`         | 0.8.x stable releases only                                          |
| `>=0.8.3 <0.9.0` | 0.8.3 through the last 0.8 patch                                    |
| `>=0.8.0-beta.1` | Betas from 0.8.0-beta.1, then 0.8.0 and later stable releases       |

Standard npm prerelease rules apply: `>=0.8.0` excludes `0.8.0-beta.1`. A prerelease must be
explicitly included for its major/minor/patch tuple; no version tags are stripped.

`paseo plugin init` writes `>=` followed by the current CLI version and pins the matching SDK
for typechecking. Raise the minimum when adopting a newer API. Add an upper bound when a later
release is incompatible; a minimum alone does not promise protection from future breaking changes.

The daemon checks its version before installing, running Git build commands, or loading a plugin,
and checks again on startup, enable, and reload. A rejected Git update keeps the installed revision.
Each connected app checks its own version before evaluating client code and shows incompatibility
in Settings → Plugins. A compatible daemon does not make an older app compatible. A plugin with no
client entry does not require the connected app to match.

For example: `Plugin "review" requires Paseo >=0.8.0. Your daemon is 0.7.2.` Use a compatible plugin
revision or update the named runtime. Releases before 0.8 do not understand this manifest field
and cannot show this new diagnostic.

### Runtime entries

| Entry              | Runtime               | Receives              | Required                                                          |
| ------------------ | --------------------- | --------------------- | ----------------------------------------------------------------- |
| `index.client.tsx` | Paseo app, per client | `PluginClientContext` | When the plugin has any UI, callback, theme, or attachment source |
| `index.server.ts`  | Daemon subprocess     | `PluginServerContext` | When the plugin handles RPCs                                      |

At least one entry is required; both accept `.ts` or `.tsx`. A directory that still has only the
old `index.ts` fails to load and points at the [migration guide](/docs/plugins/v0.8/migration).

Plugin, surface, sidebar-item, workspace-panel, Command Center item, attachment-source, and
slash-command IDs start with a lowercase letter and contain lowercase letters, numbers, or hyphens.

The generated `package.json` installs `@getpaseo/plugin` and the other host modules as development
dependencies for local typechecking and tests. Paseo supplies their runtime instances. Consumers do
not install them when adding the plugin.

Every other module lives in one of three directories. Nesting inside them is fine; a module at the
plugin root is a compile error.

| Directory | Compiled into      | Use it for                                                           |
| --------- | ------------------ | -------------------------------------------------------------------- |
| `client/` | App bundle only    | React, React Native, hooks, styles, surfaces, panels, and callbacks. |
| `server/` | Daemon bundle only | Node APIs, local resources, credentials, and RPC handlers.           |
| `shared/` | Both               | Zod RPC contracts and plain values imported by both runtimes.        |

## Runtime modules

Paseo builds each bundle from its matching entry. An import from `client/` into the daemon bundle,
from `server/` into the app bundle, or of a `node:` module anywhere in the app bundle is a compile
error. Keep `shared/` free of Node and React Native runtime code.

### Client runtime

Paseo provides these modules to client code:

| Module                          | Use it for                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `@getpaseo/plugin`              | Contribution contracts, `defineRpc`, `defineAttachmentSource`, `RpcInput`, `RpcOutput`, and data hooks |
| `@getpaseo/plugin/ui`           | Named, composable settings components                                                                  |
| `@getpaseo/plugin/react-native` | Paseo UI components and UI hooks                                                                       |
| `@getpaseo/plugin/server`       | Handler-only types such as `PluginHandlerContext`                                                      |
| `@tanstack/react-query`         | Request state and caching                                                                              |
| `react`                         | Components and hooks                                                                                   |
| `react/jsx-runtime`             | Compiled JSX                                                                                           |
| `react-native`                  | Cross-platform UI                                                                                      |
| `zod`                           | Shared schemas                                                                                         |

These exact module specifiers use the host's runtime instances. A client bundle that requests another host module fails with `Module "<name>" is not available in plugin client code`.

Do not import `lucide-react-native`, `react-native-svg`, or DOM libraries. Set contribution `icon` fields to a [Lucide icon name](https://lucide.dev/icons/); Paseo validates the name and renders the icon.

### Cross-platform rules

Client code runs on iOS, Android, and in browsers through React Native Web. A component that works
in your browser and crashes on a phone is the most common plugin bug. The rules:

| Do                                                                         | Do not                                                                      |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `View`, `Text`, `Pressable`, `ScrollView`, `TextInput` from `react-native` | `<div>`, `<span>`, `<button>`, or any HTML element                          |
| `style` objects built from `theme.colors` and `layout.compact`             | `className`, CSS strings, or hardcoded colors                               |
| `onPress`                                                                  | `onClick`, `onMouseEnter`, or other DOM handlers                            |
| `Linking`, `Clipboard`-style React Native APIs                             | `window`, `document`, `localStorage`, `navigator`, `location` in components |

The scaffold's `tsconfig.json` omits the DOM library, so `document` and `window` are type errors
everywhere by default. The one place browser APIs are allowed is `client/web.ts`. It declares the
narrow shape of each global it uses, gates every export on `Platform.OS`, and gives native the
alternative:

`client/web.ts`:

```ts
import { Linking, Platform } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
declare const window: { open(url: string, target: string, features: string): unknown };

export async function openExternal(url: string): Promise<void> {
  if (Platform.OS === "web") {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await Linking.openURL(url);
}
```

Do not add `/// <reference lib="dom" />` or `"DOM"` to `lib`; either one turns DOM types back on
for the whole project and hides the next mistake. Components import `openExternal` and never touch
`window` themselves. `layout.platform` on surface and panel props carries the same value as
`Platform.OS` for rendering decisions.

Use the [settings API](#settings-screens) for typed host-scoped persistence across clients.
Use `openSettings`, `openSurface`, and `openPanel` for your own registered contributions.

### Server runtime

Paseo provides `@getpaseo/plugin`, `@getpaseo/plugin/server`,
`@getpaseo/plugin/provider`, `@getpaseo/plugin/acp`, and `zod` to server code. Backend
contributions run in a daemon subprocess with Node access to the host machine. Keep filesystem,
process, credential, and other machine-local work under `server/`. A plugin without
`index.server.ts` starts no subprocess.

### Providers

Follow [Build a provider plugin](/docs/plugins/v0.8/providers) for direct and ACP implementations,
session lifecycle, composer settings, timeline renderers, testing, and distribution.

Call `server.registerProvider()` with a `ProviderRegistration` from
`@getpaseo/plugin/provider`. Its connection accepts inputs with `send()` and emits complete state
snapshots through `onEvent()`. `send()` reports acceptance only; prompt disposition, turns,
configuration, persistence, permissions, and failures are events.

Use the single `session.prompt` input for messages, structured commands, steering, and command side
effects. Repeat `clientMessageId` on the live user timeline item and publish exactly one matching
`session.prompt_result`. Publish provider-created children as sessions with `parentSessionId`.

Provider settings are toggle/select descriptors that Paseo renders in the composer. Keep
provider-private JSON under `providerOptions`. Host tools arrive as MCP servers in the complete
session config.

Paseo refreshes an agent by closing its current provider session and opening it with current
configuration and persistence. Providers re-read external state during `session.open`.

Use `runAcpProvider()` from `@getpaseo/plugin/acp` to adapt a command-backed ACP. Add transformer
hooks only for a vendor's discovery, configuration, notification, or tool-call differences.

`ProviderRegistration.icon` is a file path relative to the plugin directory, such as `icon.svg`.
It must resolve inside that directory to a regular SVG file no larger than 64 KiB. The SVG must be
self-contained: scripts, styles, `foreignObject`, event-handler attributes, JavaScript URLs, and
external `href` or `xlink:href` references are rejected. Fragment references such as `#mark` are
allowed. Paseo reads and sanitizes the file when the plugin starts; the string is never an inline
SVG or URL.

## Entry point and cleanup

Each present entry default-exports one contribution function and returns cleanup. Client entries
receive `PluginClientContext`; server entries receive `PluginServerContext`. Every client `add*`
returns an idempotent remover. The entry cleanup runs before Paseo removes remaining registrations.

```ts
import type { PluginClientContext } from "@getpaseo/plugin";
import { Main } from "./client/main";

export default function contribute(client: PluginClientContext) {
  client.addSurface("main", Main);
  return () => {};
}
```

Cleanup can be async. Release timers, watchers, sockets, and other resources created by the plugin. Paseo also removes registrations, unmounts surfaces, rejects pending RPCs, closes the plugin's daemon session, and stops its subprocess on reload, disable, removal, disconnect, or daemon shutdown.

## Lifecycle hooks

In `index.server.ts`:

```ts
import type { PluginServerContext } from "@getpaseo/plugin";

export default function contribute(server: PluginServerContext) {
  server.on("agent.turn_ended", (event) => {
    console.log(event.agent.id, event.outcome);
  });

  return () => {};
}
```

| Register                        | Callback receives                  | Return                                                       |
| ------------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| `server.on(name, callback)`     | `(event, { paseo, signal })`       | `void` or `Promise<void>`                                    |
| `server.before(name, callback)` | `({ request }, { paseo, signal })` | Modified request, or `undefined` to keep it; async supported |

Hooks run on the daemon while the plugin is enabled, even with no app connected.

### Change configuration and inject an MCP server

Add this callback inside `contribute(server)`. Replace the placeholder URL with your MCP endpoint.

```ts
server.before("agent.create", ({ request }) => {
  if (request.config.provider !== "codex") {
    return request;
  }

  return {
    ...request,
    config: {
      ...request.config,
      providerOptions: {
        ...request.config.providerOptions,
        sandbox_mode: "workspace-write",
        approval_policy: "on-request",
      },
      mcpServers: {
        ...request.config.mcpServers,
        company: {
          type: "http",
          url: "https://tools.example.com/mcp",
        },
      },
    },
  };
});
```

| Input                                       | Result                        |
| ------------------------------------------- | ----------------------------- |
| `providerOptions.sandbox_mode: "read-only"` | `"workspace-write"`           |
| `providerOptions.web_search: "disabled"`    | Preserved by the spread       |
| Existing `mcpServers.search`                | Preserved by the spread       |
| Existing `mcpServers.company`               | Replaced with the entry above |

The selected provider validates `providerOptions` and must support the configured MCP servers.
Explicit Codex sandbox and approval options override its mode presets.

### Inject environment variables on every session opening

```ts
server.before("agent.session_open", ({ request }) => {
  return {
    ...request,
    env: {
      ...request.env,
      COMPANY_ENV: "development",
    },
  };
});
```

This runs on create, resume, refresh, and import. To inject only on creation, set `env` in an
`agent.create` callback instead.

### Choose workspace isolation

```ts
server.before("workspace.create", ({ request }) => {
  if (request.source.kind !== "directory") {
    return request;
  }

  return {
    ...request,
    source: {
      kind: "worktree",
      cwd: request.source.path,
      action: "branch-off",
    },
  };
});
```

**Result:** an explicit directory creation request becomes a worktree request. Existing workspaces
and directory lookup/import operations are unaffected.

### Send a follow-up when a turn ends

Copy [server/inspect.ts](https://github.com/getpaseo/paseo/blob/main/plugin-examples/lifecycle-actions/server/inspect.ts)
into your plugin. `latestOutputText` joins text chunks after the latest user message.

```ts
import type { PluginServerContext } from "@getpaseo/plugin";
import { latestOutputText } from "./server/inspect";

export default function contribute(server: PluginServerContext) {
  server.on("agent.turn_ended", async (event, context) => {
    if (event.outcome.kind === "canceled") {
      return;
    }

    const text = latestOutputText(event.timeline);
    if (/out of credits/i.test(text)) {
      await context.paseo.agents.ref(event.agent.id).send("Try again.");
    }
  });

  return () => {};
}
```

```text
Turn ends: "out of credits"
  → plugin sends "Try again."
  → a new turn starts
```

This sends a new message with the existing SDK. Persistent matches keep sending follow-ups;
add limits or delays in your plugin when needed. Attachments and tool effects are not replayed.

### Answer a permission request

Using `shellCommand` from the same [helper file](https://github.com/getpaseo/paseo/blob/main/plugin-examples/lifecycle-actions/server/inspect.ts):

```ts
import type { PluginServerContext } from "@getpaseo/plugin";
import { shellCommand } from "./server/inspect";

export default function contribute(server: PluginServerContext) {
  server.on("agent.permission_requested", async (event, context) => {
    const command = shellCommand(event.request);
    if (command === null) {
      return;
    }

    const agent = context.paseo.agents.ref(event.agent.id);
    if (/\brm\s+-rf\b/.test(command)) {
      await agent.respondToPermission({
        requestId: event.request.id,
        response: { behavior: "deny", message: "Recursive deletion is blocked." },
      });
      return;
    }

    if (command.trim() === "git status") {
      await agent.respondToPermission({
        requestId: event.request.id,
        response: { behavior: "allow" },
      });
    }
  });

  return () => {};
}
```

| Request                  | Result                    |
| ------------------------ | ------------------------- |
| `rm -rf build`           | Declined                  |
| `git status`             | Approved                  |
| Other command or request | Left pending for the user |
| Already-resolved request | SDK response fails        |

The regex is an example policy, not a shell parser. Permission requests can also be questions,
plans, and mode changes; requesting permission does not end the turn.

### Events

| Name                         | Event fields                             | Trigger                                            |
| ---------------------------- | ---------------------------------------- | -------------------------------------------------- |
| `agent.created`              | `agent`                                  | Ordinary creation finishes; excludes import/resume |
| `agent.turn_started`         | `agent`, `turnId`                        | Live turn starts                                   |
| `agent.turn_ended`           | `agent`, `turnId`, `outcome`, `timeline` | Live turn completes, fails, or is canceled         |
| `agent.permission_requested` | `agent`, `request`                       | Permission or question becomes pending             |
| `agent.permission_resolved`  | `agent`, `requestId`, `resolution`       | Pending request is answered or cleared             |
| `agent.archived`             | `agent`, `archivedAt`                    | Archive state is saved                             |
| `workspace.created`          | `workspace`                              | Record created; directory available                |
| `workspace.archived`         | `workspace`                              | Archive state is saved                             |

Agent events exclude internal utility agents. Archive events can precede runtime/worktree cleanup;
`workspace.created` is not a setup barrier before agent startup.

**Shared payload shapes** (`@getpaseo/plugin/server`):

```ts
interface PluginHookAgent {
  id: string;
  workspaceId: string | null;
  parentAgentId: string | null;
  provider: string;
  cwd: string;
  title: string | null;
}

interface PluginHookWorkspace {
  id: string;
  projectId: string;
  cwd: string;
  name: string | null;
  archivedAt: string | null;
}

type PluginTurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string; code?: string } }
  | { kind: "canceled"; reason: string };
```

| Field        | Shape / meaning                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| `turnId`     | Provider-reported `string` or `null`; can repeat after a session reopens                              |
| `timeline`   | `readonly AgentTimelineItem[]`; complete snapshot including earlier conversation; text may span items |
| `request`    | SDK `AgentPermissionRequest`; `kind` is `tool`, `plan`, `question`, `mode`, or `other`                |
| `resolution` | SDK `AgentPermissionResponse`                                                                         |
| `archivedAt` | Timestamp string                                                                                      |

### Before hooks

| Name                 | Request fields                                                          | Editable                                |
| -------------------- | ----------------------------------------------------------------------- | --------------------------------------- |
| `agent.create`       | `config`, optional `env`                                                | Public agent config except `cwd`; `env` |
| `agent.session_open` | `agentId`, `workspaceId`, `provider`, `cwd`, `reason`, `purpose`, `env` | Only `env`                              |
| `workspace.create`   | `source`, optional `title`, `firstAgentContext`                         | Entire explicit creation request        |

**`agent.create.config`** uses `AgentSessionConfig`:

| Fields                                        | Constraint                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| `provider`, `model`                           | Separate fields; changing provider may require changing model/mode/options |
| `modeId`, `thinkingOptionId`, `featureValues` | Provider-specific selections                                               |
| `title`, `systemPrompt`                       | Agent configuration                                                        |
| `providerOptions`                             | Provider-specific validated options                                        |
| `mcpServers`, `toolPolicy`                    | MCP configuration and exact-tool preapprovals                              |
| `cwd`                                         | Cannot change                                                              |
| `internal`                                    | Daemon-owned; cannot change through this hook                              |

**`agent.session_open` request example:**

```json
{
  "agentId": "agent-123",
  "workspaceId": "workspace-456",
  "provider": "codex",
  "cwd": "/projects/shop",
  "reason": "resume",
  "purpose": "interactive",
  "env": { "COMPANY_ENV": "development" }
}
```

| Field         | Values                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `workspaceId` | String or `null`                                                                                                        |
| `reason`      | `create`, `resume`, `refresh`, `import`                                                                                 |
| `purpose`     | `interactive`, `history`                                                                                                |
| `env`         | Launch override map; excludes the daemon's inherited environment. Replace the map to add, replace, or remove overrides. |

### Ordering and returned values

```text
Creation request
  → agent.create hooks (plugin-ID order; registration order within each plugin)
  → resolve defaults and validate provider configuration
  → derive launch configuration with Paseo runtime tools and daemon prompt
  → agent.session_open hooks (same ordering; env only)
  → set PASEO_AGENT_ID and PASEO_AGENT_CWD
  → open provider session and save agent configuration
```

| Callback returns                                        | Next callback receives                              |
| ------------------------------------------------------- | --------------------------------------------------- |
| `{ ...request, env: { ...request.env, REGION: "eu" } }` | Prior request with `REGION` added/replaced          |
| `{ ...request, env: { REGION: "eu" } }`                 | Prior request with the entire override map replaced |
| `undefined`                                             | Unchanged request                                   |
| Throws or returns invalid data                          | Operation fails; later callbacks do not run         |

No automatic deep merge. Later callbacks can overwrite earlier values. Agent configuration is
saved; environment overrides are not persisted with it.

### Context and cleanup

| Contract                           | Behavior                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `context.paseo`                    | Existing SDK connected to this daemon                                                                     |
| `context.signal`                   | Aborted on invocation timeout or plugin stop; pass to external requests                                   |
| Input data                         | Detached snapshot; change state through returned requests or SDK commands                                 |
| Registration result                | Idempotent remover, e.g. `const remove = server.on(...); remove();`                                       |
| Reload, disable, removal, shutdown | Remaining registrations removed                                                                           |
| Unknown hook name                  | Registration fails                                                                                        |
| Hook timeout                       | 30 seconds; aborts the signal. A before hook fails the pending operation; an event handler logs an error. |
| Event-handler error                | Logged against plugin; original operation continues                                                       |
| Event delivery                     | Live, best effort; no replay, persistence, or automatic retry                                             |
| Event concurrency                  | Different events may overlap; callback completion order is not guaranteed                                 |

### Complete examples

| Plugin                                                                                                 | Includes                                                                     |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| [lifecycle-logger](https://github.com/getpaseo/paseo/tree/main/plugin-examples/lifecycle-logger)       | All eleven hooks; JSON logs with environment values redacted                 |
| [lifecycle-actions](https://github.com/getpaseo/paseo/tree/main/plugin-examples/lifecycle-actions)     | Follow-ups, permissions, environment, provider switching, worktree selection |
| [agent-configuration](https://github.com/getpaseo/paseo/tree/main/plugin-examples/agent-configuration) | MCP injection and Codex sandbox/approval options                             |

Read logger output with `paseo plugin logs lifecycle-logger` or the host's `daemon.log`.

## Surfaces and sidebar items

Register a component, then point a sidebar item at its surface ID:

`client/main.tsx`:

```tsx
import type { PluginSurfaceProps } from "@getpaseo/plugin";
import { useMemo } from "react";
import { Text, View } from "react-native";

export function Main({ theme, host, layout }: PluginSurfaceProps) {
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      },
      title: { color: theme.colors.foreground },
      detail: { color: theme.colors.foregroundMuted },
    }),
    [theme, layout.compact],
  );
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{host.label}</Text>
      <Text style={styles.detail}>{layout.platform}</Text>
    </View>
  );
}
```

`index.client.tsx`:

```ts
import type { PluginClientContext } from "@getpaseo/plugin";
import { Main } from "./client/main";

export default function contribute(client: PluginClientContext) {
  client.addSurface("main", Main);
  client.addSidebarItem({
    id: "main",
    title: "My plugin",
    icon: "Blocks",
    surface: "main",
  });
  return () => {};
}
```

`PluginSurfaceProps` contains:

| Field        | Meaning                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `theme`      | Typed `PluginTheme` color tokens for the active Paseo theme.                                                                 |
| `host`       | Selected host `id` and display `label`.                                                                                      |
| `layout`     | `compact` and the `ios`, `android`, or `web` platform.                                                                       |
| `navigation` | Optional client navigation. `openAgent({ agentId })` and `openWorkspace({ workspaceId })` open targets on the selected host. |

Paseo owns the route, header, close action, host picker, error boundary, and query client. The plugin owns the surface body.

## Host UI

Import Paseo-owned UI from `@getpaseo/plugin/react-native` in client code. This example
opens a controlled modal, renders a host icon, and confirms the action with a toast:

```tsx
import type { PluginSurfaceProps } from "@getpaseo/plugin";
import { Icon, Modal, useToast } from "@getpaseo/plugin/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

export function IssueActions({ theme }: PluginSurfaceProps) {
  const [open, setOpen] = useState(false);
  const toast = useToast();

  function saveIssue() {
    toast.show("Issue saved", { variant: "success" });
    setOpen(false);
  }

  return (
    <View>
      <Pressable accessibilityRole="button" onPress={() => setOpen(true)}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name="Pencil" size={18} color={theme.colors.foreground} />
          <Text style={{ color: theme.colors.foreground }}>Edit issue</Text>
        </View>
      </Pressable>

      <Modal
        title="Edit issue"
        icon={<Icon name="Pencil" size={18} color={theme.colors.foreground} />}
        open={open}
        onOpenChange={setOpen}
      >
        <Modal.Content>
          <Pressable accessibilityRole="button" onPress={saveIssue}>
            <Text style={{ color: theme.colors.foreground }}>Save</Text>
          </Pressable>
        </Modal.Content>
      </Modal>
    </View>
  );
}
```

### Modal

`Modal` uses a bottom sheet on compact layouts and a centered dialog otherwise. The plugin owns
the `open` state.

| Prop           | Type                      | Required | Behavior                                     |
| -------------- | ------------------------- | -------- | -------------------------------------------- |
| `title`        | `string`                  | Yes      | Labels the modal and its visible header.     |
| `icon`         | `ReactNode`               | No       | Renders before the title in the header.      |
| `open`         | `boolean`                 | Yes      | Shows the modal content when `true`.         |
| `onOpenChange` | `(open: boolean) => void` | Yes      | Receives `false` when the user dismisses it. |
| `children`     | `ReactNode`               | Yes      | Contains `Modal.Content`.                    |

`Modal.Content` owns the body below the host-rendered header:

| Prop                    | Type                   | Default            | Behavior                                                                          |
| ----------------------- | ---------------------- | ------------------ | --------------------------------------------------------------------------------- |
| `children`              | `ReactNode`            | Required           | Body content below the header.                                                    |
| `style`                 | `StyleProp<ViewStyle>` | —                  | Styles the full body viewport, including empty space. Use for backgrounds.        |
| `contentContainerStyle` | `StyleProp<ViewStyle>` | Padding 24, gap 16 | Overrides the content layout. Set `padding: 0, gap: 0` for edge-to-edge rows.     |
| `scrollable`            | `boolean`              | `true`             | The host scrolls the body. Set `false` for a bounded body with your own scroller. |

A plain `Modal.Content` is already padded and scrollable. Avoid adding a second padded wrapper
unless you want another inset. Body styles leave the host header, drag handle, and dismissal controls
intact. The host reserves bottom safe-area space on compact native layouts; setting content padding
to zero removes the decorative inset, not that space. Keyboard clearance is handled separately.

With `scrollable={false}`, the body fills the available sheet height, and the centered dialog uses
85% of the available height. Use `flex: 1, minHeight: 0` on your list. Default scrolling dialogs stay
content-sized on wide layouts. Presentation follows window size, including narrow desktop windows
and wide tablets.

The close button, backdrop, platform back action, web Escape key, and compact sheet gesture dismiss
the modal. Dismissal calls `onOpenChange(false)`; the plugin must update `open` to close it.

Modal children keep the plugin runtime context. `usePaseo`, `useRpc`, `useWorkspace`, and
`useAgent` work inside them.

### Scrolling

Import `ScrollView` and `FlatList` from `@getpaseo/plugin/react-native` when content can appear in a
Paseo modal. They accept React Native props and refs and integrate with the sheet's gestures. Outside
a sheet they use ordinary React Native scrolling. Do not import bottom-sheet libraries directly.

Use one vertical scroll owner: either the default modal body, or your own list with
`scrollable={false}`. A fixed-height vertical list nested inside the default scrolling body can compete
with the sheet for gestures on Android. Horizontal scrolling can coexist with the host's vertical body.

Both the default body and SDK lists share native sheet gestures: drag up to expand before scrolling;
drag down at the top of the list to collapse or dismiss. `scrollable={false}` removes the host's scroll
container without changing these gestures. Expand the sheet before using list methods such as
`scrollToEnd`; the sheet locks list offsets below its largest height.

```tsx
import { FlatList, Modal } from "@getpaseo/plugin/react-native";
import { Text } from "react-native";

// Inside your controlled Modal:
<Modal.Content
  scrollable={false}
  style={{ backgroundColor: theme.colors.surface1 }}
  contentContainerStyle={{ padding: 0, gap: 0 }}
>
  <FlatList
    style={{ flex: 1, minHeight: 0 }}
    data={items}
    keyExtractor={(item) => item.id}
    renderItem={({ item }) => (
      <Text style={{ padding: 16, color: theme.colors.foreground }}>{item.title}</Text>
    )}
  />
</Modal.Content>;
```

For horizontal tabs, place `<ScrollView horizontal style={{ flexGrow: 0 }}>…</ScrollView>` inside the
default `Modal.Content`. Keep the content's vertical scrolling on the host.

### Copy and paste

`copyText(text): Promise<void>` writes to the clipboard on the device running the app. Call it from a
user action and await it before reporting success. It rejects if the platform denies copying or the
clipboard is unavailable; browser permissions and secure-context requirements still apply.

```tsx
import { copyText, useToast } from "@getpaseo/plugin/react-native";

// Inside your component:
const toast = useToast();
async function copyResult() {
  try {
    await copyText(result);
    toast.show("Copied", { variant: "success" });
  } catch {
    toast.error("Could not copy. Select the text and use Copy.");
  }
}
```

Programmatic copying and native text selection are separate interactions. Use `<Text selectable>`
for long-press selection and OS Copy. Import `TextInput` from `@getpaseo/plugin/react-native` for modal forms. It accepts React Native
input props and refs, supports OS Paste, and registers focus with the native sheet so the keyboard
can raise the form. Outside a sheet it uses the ordinary input. A plain React Native input supports
Paste too, but does not register focus with the sheet; the keyboard can cover it. No clipboard read
API is needed for OS Paste. Avoid DOM clipboard code in native plugins and the deprecated
`Clipboard` export from `react-native`.

The runnable [modal UI example](https://github.com/getpaseo/paseo/tree/main/plugin-examples/modal-ui)
contains a padded form, full-width rows, a virtualized list, horizontal tabs, and a copy/paste input.

### Toasts

`useToast()` returns two methods:

| Method                    | Behavior                                                    |
| ------------------------- | ----------------------------------------------------------- |
| `show(message, options?)` | Shows a toast for 2,200 ms unless `durationMs` is supplied. |
| `error(message)`          | Shows an error toast for 3,200 ms.                          |

`show` accepts these options:

| Option       | Type                                                       | Default     |
| ------------ | ---------------------------------------------------------- | ----------- |
| `variant`    | `"default" \| "info" \| "success" \| "warning" \| "error"` | `"default"` |
| `durationMs` | `number`                                                   | `2200`      |

Showing another toast replaces the currently visible toast. An empty message is ignored.

### Icons

`Icon` renders a [Lucide icon](https://lucide.dev/icons/) from Paseo's installed icon set. Plugin bundles do not import
`lucide-react-native` or `react-native-svg`.

| Prop    | Type     | Required | Behavior                                        |
| ------- | -------- | -------- | ----------------------------------------------- |
| `name`  | `string` | Yes      | Lucide icon name. Unknown names render nothing. |
| `size`  | `number` | No       | Icon width and height.                          |
| `color` | `string` | No       | Icon color. Use a plugin theme token.           |

## Timeline items

A plugin can replace an agent timeline entry with its own data and React Native renderer. Both
registrations are client contributions. Paseo applies the transformer while building the render
model, including every live streaming update.

```tsx
import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin";
import { Text } from "react-native";
import { z } from "zod";

const schema = z.object({ label: z.string() });

function Card({ item, theme }: PluginTimelineItemProps<z.output<typeof schema>>) {
  return <Text style={{ color: theme.colors.foreground }}>{item.data.label}</Text>;
}

export default function contribute(client: PluginClientContext) {
  client.addTimelineTransformer({
    id: "command-card",
    query: { itemType: "tool_call" },
    transform({ item, phase }) {
      return {
        items: [
          {
            type: "plugin",
            kind: "command-card",
            version: 1,
            data: { label: item.name, phase },
          },
        ],
      };
    },
  });
  client.addTimelineRenderer({
    kind: "command-card",
    version: 1,
    schema,
    Component: Card,
  });
  return () => {};
}
```

`query.itemType` is the stable, coarse selector. Inspect the selected item inside `transform` for
provider- or tool-specific recognition. Returning `undefined` keeps the original entry. Returning
`items` replaces it; an empty array removes it. Item `data` must be JSON-compatible. The `phase`
input is `"streaming"` for running tool calls and loading reasoning, and `"complete"` otherwise.
Each replacement may set an optional plugin-local `id`; otherwise Paseo uses its index within that
source item's output.

Renderers receive `agentId`, `item`, `timestamp`, `theme`, `host`, and `layout`. Paseo validates
`item.data` with the registered schema before rendering. Keep transformers synchronous and
deterministic. Paseo memoizes results by source-item reference and derives replacement identity from
the source row, so updates to one streaming item do not remount its renderer. Use the exported
`useRevealedText(text, phase)` hook when a renderer should pace streaming text like Paseo's built-in
assistant rows.

### Append a timeline row from the daemon

A server handler can add a plugin-owned row to canonical history:

```ts
import type { PluginHandlerContext } from "@getpaseo/plugin";

async function publishReview(agentId: string, { paseo }: PluginHandlerContext) {
  await paseo.agents.ref(agentId).timeline.append({
    type: "plugin",
    id: "review",
    kind: "review-result",
    version: 1,
    data: { verdict: "ready" },
  });
}
```

| Field     | Type             | Required | Behavior                                                       |
| --------- | ---------------- | -------- | -------------------------------------------------------------- |
| `type`    | `"plugin"`       | Yes      | Selects the plugin timeline variant.                           |
| `id`      | `string`         | Yes      | Stable plugin-local identity. Reusing it replaces the old row. |
| `kind`    | `string`         | Yes      | Selects the registered renderer.                               |
| `version` | positive integer | Yes      | Selects the renderer contract version.                         |
| `data`    | JSON-compatible  | Yes      | Renderer payload, at most 64 KiB after JSON serialization.     |

The daemon stamps `pluginId` from the calling plugin session and rejects this RPC from non-plugin
sessions. The row appears live, survives timeline refetches, and keeps only the latest value for the
same plugin and `id`. If its renderer is missing, Paseo shows the existing unavailable row. Daemons
reject `data` over the limit rather than truncating it. Daemons that support this operation
advertise `server_info.features.pluginTimelineItems`.

## Theme and layout

Plugin UI runs on desktop, browser, iOS, and Android, across every Paseo theme. `theme` is a typed `PluginTheme` mapped from the active host theme. Color and spacing must come from those props. Hardcoded colors and unstyled `Text` break when the host theme changes.

Recreate styles when `theme` or `layout.compact` changes.

| Key                             | Required for               | Use it for                          |
| ------------------------------- | -------------------------- | ----------------------------------- |
| `theme.colors.foreground`       | Every primary `Text`       | Titles and body copy                |
| `theme.colors.foregroundMuted`  | Secondary `Text`           | Labels and supporting copy          |
| `theme.colors.surface0`         | Root view                  | Panel background                    |
| `theme.colors.surface1`         | Raised surfaces            | Cards and panels                    |
| `theme.colors.surface2`         | Control surfaces           | Inputs and secondary controls       |
| `theme.colors.border`           | Surface boundaries         | Borders and dividers                |
| `theme.colors.accent`           | Primary action fills       | Buttons and selected states         |
| `theme.colors.accentForeground` | Text on an accent fill     | Button labels                       |
| `theme.colors.statusSuccess`    | Success feedback           | Success messages and indicators     |
| `theme.colors.statusWarning`    | Warning feedback           | Warning messages and indicators     |
| `theme.colors.statusDanger`     | Failure copy               | Error messages and destructive text |
| `layout.compact`                | Padding and stacking       | `true` on mobile and narrow windows |
| `layout.platform`               | Platform-specific behavior | `ios`, `android`, or `web`          |

Do not hardcode `#000`, `#fff`, or React Native's default text color. Primary copy uses `foreground`. Labels use `foregroundMuted`. Tighten padding when `layout.compact` is true.

Workspace and agent panels receive the same `theme`, `layout`, and optional `navigation` fields.

## Contribute a theme

`addTheme` adds a light or dark theme to Settings → Appearance, listed under the built-ins by its
`name`. A theme is data, so it needs no component file:

```ts
import type { PluginClientContext } from "@getpaseo/plugin";

export default function contribute(client: PluginClientContext) {
  client.addTheme({
    id: "mocha",
    name: "Catppuccin Mocha",
    appearance: "dark",
    colors: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      raised: "#313244",
      control: "#45475a",
      border: "#45475a",
      accent: "#cba6f7",
      mutedForeground: "#a6adc8",
      ring: "#6c7086",
    },
  });
  return () => {};
}
```

Every color is a hex string; anything else fails to load. Paseo expands the palette into the full
token set the built-in dark themes use, so a contributed theme covers panels, menus, diffs, status
colors, and the terminal without listing them.

| Color             | Becomes                                                           |
| ----------------- | ----------------------------------------------------------------- |
| `background`      | App, workspace, and terminal background                           |
| `foreground`      | Primary text, terminal foreground and cursor                      |
| `raised`          | Cards, popovers, and hovered rows                                 |
| `control`         | Inputs, secondary fills, and the light-theme sidebar              |
| `border`          | Borders and the highest raised-surface tint                       |
| `accent`          | Buttons, selection, and focus. Optional; `foreground` if omitted. |
| `mutedForeground` | Secondary text                                                    |
| `ring`            | Focus rings, scrollbars, and terminal bright black                |

`appearance` is `"light"` or `"dark"`. Paseo uses it to select the matching surface, status,
diff, syntax, terminal, and shadow derivation.

Only one contributed theme is active at a time. Selecting one persists the choice; if the plugin is
later disabled or removed, Paseo falls back to the default theme rather than leaving the app
unpainted.

Themes need a host that supports them. A client released before `addTheme` cannot evaluate that client entry and reports
`client.addTheme is not a function`. Update the client.

## Settings screens

Register a component with `client.addSettingsScreen({ id, title, icon, Component })` in
`index.client.tsx`. It appears under **Settings → Plugins → your plugin** on that host.
`id` is unique within the installation; `icon` is a Lucide name. Registration returns an
idempotent remover, and plugin teardown removes remaining screens.

Call `client.openSettings(id)` or a Command Center callback's `openSettings(id)` to open one
of your own screens. Each installation has its own values and route, even when several hosts
install the same plugin.

The component receives `PluginSurfaceProps`. Paseo owns the header, back navigation, safe areas,
scrolling, and the centered settings column. Compact windows push a full-screen detail; wide
windows keep the settings sidebar. Render content inside that frame using React Native components.
A disabled or removed plugin leaves an unavailable screen with working Back navigation.

### Named UI components

Import settings components from `@getpaseo/plugin/ui`. They work with your own state and RPCs;
no form wrapper or storage binding is required.

```tsx
import { useState } from "react";
import { SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/ui";

export function DisplaySettings() {
  const [visible, setVisible] = useState(true);
  return (
    <SettingsSection title="Display">
      <SettingsCard>
        <SettingsSwitch label="Show metadata" value={visible} onValueChange={setVisible} />
      </SettingsCard>
    </SettingsSection>
  );
}
```

| Component                          | Props and behavior                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `SettingsGroup`, `SettingsSection` | Required `title`, `children`; optional `info` tooltip, `trailing` content, `testID`. Own section spacing and headings.                   |
| `SettingsCard`                     | `children`, optional `testID`. Owns the card surface and dividers between direct children. Give mapped rows stable React keys.           |
| `SettingsRow`                      | Required `label`; optional `hint`, `error`, `children`, `testID`. Wrap any custom control or content.                                    |
| `SettingsSwitch`                   | Row props plus required `value: boolean`, `onValueChange`; optional `disabled`.                                                          |
| `SettingsSelect`                   | Row props plus required string `value`, `options: { label, value }[]`, `onValueChange`; optional `disabled`. Uses Paseo's adaptive menu. |
| `SettingsInput`                    | Row props plus required `onChangeText`; optional `initialValue`, `placeholder`, `disabled`, `secureTextEntry`, `ref`.                    |
| `SettingsAction`                   | Row props plus required `actionLabel`, `onPress`; optional `disabled`.                                                                   |

`SettingsInput` owns in-progress text. `initialValue` seeds it when mounted. Its ref exposes
`focus()`, `blur()`, `getText()`, and `replaceText(text)` for explicit programmatic changes.
Keep draft text outside persisted values until the user saves. Custom previews and controls
can sit beside or inside these components.

### Persisted values

Define a settings document in `shared/`:

```ts
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const preferences = defineSettings({
  id: "display",
  scope: "host",
  version: 1,
  schema: z.object({ showMetadata: z.boolean().default(true) }),
});
```

Register it with `server.registerSettings(preferences)` in `index.server.ts` before returning
cleanup. This server entry is required for built-in persistence; a screen using its own data
can remain client-only.

| Definition field               | Contract                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                           | Lowercase identifier matching `[a-z][a-z0-9_-]*`; unique within the installation.                                                    |
| `scope`                        | Required `"host"`. All authorized clients of that host share the document. No per-user, device-local, or cross-host synchronization. |
| `version`                      | Required positive integer describing the schema, independent of the write revision.                                                  |
| `schema`                       | Zod schema for JSON values. Supply defaults so parsing `{}` produces a complete document.                                            |
| `migrate(values, fromVersion)` | Optional synchronous or asynchronous conversion from an older stored version. Its output must pass the current schema.               |

Call `useSettings(preferences)` in any contributed component. It returns a discriminated state:

| `status`  | Available data                                                           |
| --------- | ------------------------------------------------------------------------ |
| `loading` | Read is pending; do not render default values as though they were saved. |
| `ready`   | Typed `values` and an opaque `revision`.                                 |
| `invalid` | `error` and `revision`; stored data is preserved.                        |
| `error`   | `error` from the read/connection.                                        |

Every state also exposes `saving`, `saveError`, and these actions:

- `save(values, revision): Promise<boolean>` validates and saves a complete document. Returns
  `false` and sets `saveError` on validation, conflict, or transport failure; it does not throw.
- `reset(): Promise<boolean>` explicitly replaces the document with schema defaults, using the
  revision loaded by the hook. It can recover invalid stored data.
- `reload(): Promise<void>` clears the save error and reads again. Your component owns its draft;
  reloading does not discard that draft automatically.

For an immediate toggle, pass `{ ...settings.values, showMetadata }` and `settings.revision`
to `save`. For a draft editor, capture both the values and revision when opening it. Keep that
revision until a save succeeds or the user discards the draft. A stale revision rejects the
save, preserving both the draft and the newer saved values.

Writes are atomic and validated on the host. Connected clients receive updates without reloading
the plugin. Values survive daemon restart, plugin reload, disable, and updates. Removing an
installation deletes its settings. Reinstalling that ID starts from defaults.

A missing document uses schema defaults. Invalid data, failed migrations, and unsupported newer
versions produce `invalid` without silently resetting the file. Successful migrations persist
the new version once. These documents are ordinary host-side JSON, not a credential vault.
Settings RPCs use the existing `daemon.manage` permission for plugin execution.

See the complete [settings example](https://github.com/getpaseo/paseo/tree/main/plugin-examples/settings)
for immediate controls, a draft editor with validation, custom content, and Command Center navigation.

## Workspace panels

Register one panel for workspace or agent context:

`client/review.tsx`:

```tsx
import { type PluginAgentPanelProps, useAgent, useWorkspace } from "@getpaseo/plugin";
import { useMemo } from "react";
import { Text, View } from "react-native";

export function ReviewPanel({ theme, layout, workspaceId, agentId }: PluginAgentPanelProps) {
  const workspaceName = useWorkspace(workspaceId, (workspace) => workspace.name);
  const agent = useAgent(agentId, ({ id, title }) => ({ id, title }));
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      },
      title: { color: theme.colors.foreground },
      detail: { color: theme.colors.foregroundMuted },
    }),
    [theme, layout.compact],
  );
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{workspaceName}</Text>
      <Text style={styles.detail}>{agent?.title ?? agent?.id}</Text>
    </View>
  );
}
```

`index.client.tsx`:

```ts
import type { PluginClientContext } from "@getpaseo/plugin";
import { ReviewPanel } from "./client/review";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "review",
    title: "Review",
    icon: "Scan",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: ReviewPanel,
  });
  return () => {};
}
```

`addWorkspacePanel` fields:

| Field       | Required | Meaning                                                       |
| ----------- | -------- | ------------------------------------------------------------- |
| `id`        | Yes      | Plugin-local panel ID.                                        |
| `title`     | Yes      | Workspace-tab title.                                          |
| `icon`      | Yes      | Lucide icon name.                                             |
| `context`   | Yes      | `workspace` or `agent`.                                       |
| `locations` | No       | `workspace` and/or `explorer`. Defaults to `workspace`.       |
| `Component` | Yes      | React Native component matching the selected context's props. |

A workspace panel receives `PluginWorkspacePanelProps`: `context: "workspace"`, `theme`, `host`, `layout`, and `workspaceId`. An agent panel receives `PluginAgentPanelProps`: `context: "agent"`, the same common fields and `workspaceId`, plus `agentId`.

Read cached state with `useWorkspace(workspaceId, selector)` and `useAgent(agentId, selector)`. A selector is required. Paseo compares its result shallowly, so selecting `{ name, status }` does not re-render when unrelated fields change. Select every field the component renders in one call; do not select the whole snapshot.

Both hooks return `null` when the record is unavailable. Otherwise they run synchronously against normalized client state. Snapshot DTOs and their nested values are deeply readonly and frozen at runtime. Do not call plugin RPC to discover the current workspace or agent. Fetch optional or vendor-specific enrichment after the component renders.

Workspace snapshot fields:

| Field                | Type                                                              |
| -------------------- | ----------------------------------------------------------------- |
| `id`                 | `string`                                                          |
| `projectId`          | `string`                                                          |
| `projectDisplayName` | `string`                                                          |
| `projectRootPath`    | `string`                                                          |
| `directory`          | `string`                                                          |
| `projectKind`        | `"git" \| "non_git" \| "directory"`                               |
| `kind`               | `"directory" \| "local_checkout" \| "checkout" \| "worktree"`     |
| `name`               | `string`                                                          |
| `title`              | `string \| null`                                                  |
| `status`             | `"needs_input" \| "failed" \| "running" \| "attention" \| "done"` |
| `statusEnteredAt`    | ISO timestamp or `null`                                           |
| `archivingAt`        | ISO timestamp or `null`                                           |
| `diffStat`           | `{ additions: number; deletions: number } \| null`                |

Agent snapshot fields:

| Field               | Type                                                           |
| ------------------- | -------------------------------------------------------------- |
| `id`                | `string`                                                       |
| `workspaceId`       | `string`                                                       |
| `provider`          | `string`                                                       |
| `status`            | `"initializing" \| "idle" \| "running" \| "error" \| "closed"` |
| `createdAt`         | ISO timestamp                                                  |
| `updatedAt`         | ISO timestamp                                                  |
| `lastActivityAt`    | ISO timestamp                                                  |
| `title`             | `string \| null`                                               |
| `cwd`               | `string`                                                       |
| `model`             | `string \| null`                                               |
| `currentModeId`     | `string \| null`                                               |
| `thinkingOptionId`  | `string \| null`                                               |
| `requiresAttention` | `boolean`                                                      |
| `attentionReason`   | `"finished" \| "error" \| "permission" \| null`                |
| `parentAgentId`     | `string \| null`                                               |
| `labels`            | `Record<string, string>`                                       |

Paseo owns tab focus, splitting, closing, persistence, query state, the API/RPC providers, and the render error boundary. A restored tab whose plugin, panel, context, workspace, or agent is unavailable stays open with an unavailable message instead of crashing the workspace.

## Command Center items

Open the Command Center with **⌘K** on macOS or **Ctrl+K** on Windows and Linux, then search for the item title.

Register an action and open a panel from the callback:

```tsx
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const refreshReview = defineRpc({
  name: "review.refresh",
  input: z.object({ agentId: z.string() }),
  output: z.object({ refreshed: z.boolean() }),
});

client.addCommandCenterItem({
  id: "open-review",
  title: "Open review",
  icon: "Scan",
  keywords: ["inspect"],
  context: "agent",
  async onSelect({ paseo, rpc, workspace, agent, openPanel }) {
    await paseo.workspaces.ref(workspace.id).setTitle(`Review ${agent.id}`);
    await rpc(refreshReview, { agentId: agent.id });
    openPanel("review");
  },
});
```

`addCommandCenterItem` fields:

| Field      | Required | Meaning                                        |
| ---------- | -------- | ---------------------------------------------- |
| `id`       | Yes      | Plugin-local item ID.                          |
| `title`    | Yes      | Search result title.                           |
| `icon`     | Yes      | Lucide icon name.                              |
| `keywords` | No       | Additional Command Center search terms.        |
| `context`  | Yes      | `global`, `workspace`, or `agent`.             |
| `onSelect` | Yes      | Client-side callback for the matching context. |

Global items appear on the installation's selected host. Workspace items appear only when that host has an active cached workspace. Agent items appear only when the focused workspace tab is an agent or an agent-context plugin panel whose cached record belongs to that workspace. Missing context removes the item rather than calling the plugin to discover it.

Every callback receives:

| Field                     | Context             | Meaning                                                                                                         |
| ------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `context`                 | All                 | Matching discriminator.                                                                                         |
| `paseo`                   | All                 | Selected host's existing `PaseoApi`.                                                                            |
| `rpc(contract, input)`    | All                 | Typed call to this installation's daemon-side plugin handler.                                                   |
| `openSurface(id)`         | All                 | Opens one of this plugin's registered global surfaces.                                                          |
| `workspace`               | Workspace and agent | Synchronous workspace snapshot.                                                                                 |
| `agent`                   | Agent               | Synchronous matching agent snapshot.                                                                            |
| `openPanel(id, options?)` | Workspace and agent | Opens a registered panel in the callback's current context. Pass `{ location: "explorer" }` to target Explorer. |

An agent callback may open either an agent panel or a workspace panel. A workspace callback may open only a workspace panel. Unknown surface and panel IDs fail visibly. Use `paseo` for normal workspace, agent, provider, and daemon-config operations. Use `rpc` for plugin-specific filesystem, credential, vendor, or daemon-local work.

## Slash commands

Register a command that runs in the Paseo client when the user submits `/name args` from the
message composer. The text is never sent to the agent:

```ts
client.addSlashCommand({
  name: "review",
  description: "Run the review bot",
  argumentHint: "[scope]",
  context: "agent",
  async onSubmit({ args, agent, rpc, openPanel }) {
    await rpc(refreshReview, { agentId: agent.id, scope: args });
    openPanel("review");
  },
});
```

| Field          | Required | Meaning                                        |
| -------------- | -------- | ---------------------------------------------- |
| `name`         | Yes      | Command name without the leading slash.        |
| `description`  | Yes      | Composer autocomplete description.             |
| `argumentHint` | Yes      | Short usage hint shown after the command name. |
| `context`      | Yes      | `"workspace"` or `"agent"`.                    |
| `onSubmit`     | Yes      | Client callback for the matching context.      |

`onSubmit` receives the matching Command Center callback context plus `args`. For `/review src`,
`args` is `"src"`; Paseo trims only the remainder's leading and trailing whitespace and leaves
parsing to the plugin. Paseo owns the autocomplete row, input clearing, and the error toast. It
does not wait for `onSubmit` or show a pending state; use a composer pill or panel for that.

Precedence is built-in client commands, plugin commands, then provider commands. A lower-precedence
collision is omitted. Built-in aliases also reserve their names. The first plugin in stable catalog
order wins a collision between plugins. Commands do not run while the composer has attachments.

## Composer pills

The client entry owns pill creation and removal. This can live directly in `index.client.tsx` or in
a function it imports from `client/`:

```tsx
import {
  Icon,
  type PluginClientContext,
  type PluginComposerPillProps,
  useAgent,
} from "@getpaseo/plugin";
import { Text } from "react-native";

function ReviewPill({ theme, agentId }: PluginComposerPillProps) {
  const agent = useAgent(agentId, ({ title }) => ({ title }));
  return (
    <>
      <Icon name="Scan" size={14} color={theme.colors.foregroundMuted} />
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, flexShrink: 1 }}>
        {agent?.title ?? "Review"}
      </Text>
    </>
  );
}

export default function contribute(client: PluginClientContext) {
  const pills = new Map<string, () => void>();
  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (update.kind !== "upsert" || !update.agent.workspaceId) return;
    const { id: agentId, workspaceId } = update.agent;
    pills.get(agentId)?.();
    pills.set(
      agentId,
      client.addComposerPill({
        id: "review",
        title: "Open review",
        workspaceId,
        agentId,
        Component: ReviewPill,
        async onPress() {
          await client.rpc(refreshReview, { agentId });
          client.openPanel("review", { workspaceId, agentId });
        },
      }),
    );
  });
  return () => {
    unsubscribe();
    for (const remove of pills.values()) remove();
  };
}
```

`addComposerPill` fields:

| Field         | Required | Meaning                                                    |
| ------------- | -------- | ---------------------------------------------------------- |
| `id`          | Yes      | Plugin-local ID within the target agent.                   |
| `title`       | Yes      | Accessible button label.                                   |
| `workspaceId` | Yes      | Workspace whose composer track owns the pill.              |
| `agentId`     | Yes      | Agent whose composer track owns the pill.                  |
| `Component`   | Yes      | React Native component rendering the pill's icon and text. |
| `onPress`     | Yes      | Client-side callback.                                      |

The client entry runs once per plugin installation in each connected app. Its context exposes
`paseo`, typed `rpc`, `openSurface`, explicit-context `openPanel`, and every client registration.
`addComposerPill` returns an idempotent removal function. Paseo also removes every outstanding pill
when the plugin installation or host connection is torn down.

Paseo owns the pressable, shared pill chrome, pending state, error reporting, and track-bar
placement. The component receives `theme`, `host`, `layout`, `workspaceId`, and `agentId`. Read
current values with `useWorkspace` and `useAgent`. The plugin owns when the pill exists, its icon
and text, and the callback. `openPanel(id, { workspaceId, agentId? })` opens or focuses a panel
registered by the same plugin.

## Use the Paseo SDK

Use `usePaseo()` for ordinary Paseo operations from a surface. It borrows the selected host's existing connection; do not create another client.

```tsx
import { usePaseo } from "@getpaseo/plugin";
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

The returned API covers projects, workspaces, agents, terminals, providers, and daemon config. See the [SDK API reference](/docs/sdk/reference) for its methods. Connection lifecycle methods are intentionally absent because Paseo owns the connection.

## Add plugin-specific backend behavior

Use plugin RPC only for work that is not a normal Paseo operation: reading a vendor API, accessing daemon-local resources, or keeping credentials off the client.

Define one contract with Zod, handle it in the subprocess, and call it from the surface:

`shared/greeting.ts`:

```ts
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const greeting = defineRpc({
  name: "greeting.create",
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string() }),
});
```

`client/greeting.tsx`:

```tsx
import { useRpc } from "@getpaseo/plugin";
import { greeting } from "../shared/greeting";

export function GreetingButton() {
  const createGreeting = useRpc(greeting);
  // Call createGreeting({ name: "Ada" }) from an event or query.
  return null;
}
```

`server/greeting.ts`:

```ts
import type { RpcInput } from "@getpaseo/plugin";
import { greeting } from "../shared/greeting";

export function createGreeting({ name }: RpcInput<typeof greeting>) {
  return { message: `Hello, ${name}` };
}
```

`index.client.tsx`:

```ts
import type { PluginClientContext } from "@getpaseo/plugin";
import { GreetingButton } from "./client/greeting";

export default function contribute(client: PluginClientContext) {
  client.addSurface("main", GreetingButton);
  return () => {};
}
```

`index.server.ts`:

```ts
import type { PluginServerContext } from "@getpaseo/plugin";
import { createGreeting } from "./server/greeting";
import { greeting } from "./shared/greeting";

export default function contribute(server: PluginServerContext) {
  server.handle(greeting, createGreeting);
  return () => {};
}
```

Inputs and outputs are validated on both sides. RPC names start with a lowercase letter and contain lowercase letters, numbers, dots, hyphens, or underscores. `useRpc()` returns a typed async function. Use TanStack Query for request state, caching, and mutations.

Backend handlers receive the same `PaseoApi` as `{ paseo }`. Their connection belongs to the subprocess and closes when the plugin stops. Backend code can use Node APIs and dependencies installed in the plugin directory.

## Debug backend output

Backend contributions can write to stdout and stderr with normal Node logging:

```ts
console.log("Refreshing issues");
console.error("Issue refresh failed", error);
```

Paseo adds `[paseo]` entries when the plugin starts loading, becomes ready, starts stopping, and has
stopped. It records compilation and load failures as stderr entries, including failures that happen
before the plugin subprocess starts. Paseo also captures output emitted during initialization, RPC
handlers, cleanup, and process failure. Protocol traffic uses a separate channel, so `console.log()`
cannot corrupt plugin RPCs.

Open **Settings → Plugins → Logs** for the plugin, or inspect the same recent tail from the daemon
CLI:

```bash
paseo plugin logs my-plugin
paseo plugin logs my-plugin --json
paseo --host <url> plugin logs my-plugin
```

The command returns a snapshot rather than following live output. Refresh the settings view or run
the command again for newer entries. Each entry includes its timestamp, stdout or stderr stream,
sequence, and message.

Paseo retains up to 500 entries and 256 KiB per plugin in memory. Individual lines are capped at
16 KiB. Reload, disable, compilation failure, initialization failure, and process failure retain the
tail. Removing the plugin clears it, and a daemon restart starts a new tail. Structured copies are
also written to the daemon log at `$PASEO_HOME/daemon.log`.

Only daemon-side output is captured. Logs from client surfaces remain in the app runtime. Do not log
credentials, access tokens, or other secrets: connected users can read the retained tail, and the
daemon log persists it.

## Add a composer attachment source

An attachment source searches external resources and returns a stable text snapshot for an agent prompt. Keep credentials and vendor calls in the backend handler.

`shared/issues.ts`:

```ts
import { defineAttachmentSource, defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const searchIssues = defineRpc({
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

export const issues = defineAttachmentSource({
  id: "issues",
  title: "Acme issue",
  icon: "CircleDot",
  pickerTitle: "Attach Acme issue",
  searchPlaceholder: "Search by identifier or title",
  search: searchIssues,
});
```

`server/issues.ts`:

```ts
import type { RpcInput } from "@getpaseo/plugin";
import { searchIssues } from "../shared/issues";

export function search({ query }: RpcInput<typeof searchIssues>) {
  return searchAcmeIssues(query);
}
```

`index.client.tsx`:

```ts
import type { PluginClientContext } from "@getpaseo/plugin";
import { issues } from "./shared/issues";

export default function contribute(client: PluginClientContext) {
  client.addAttachmentSource(issues);
  return () => {};
}
```

`index.server.ts`:

```ts
import type { PluginServerContext } from "@getpaseo/plugin";
import { search } from "./server/issues";
import { searchIssues } from "./shared/issues";

export default function contribute(server: PluginServerContext) {
  server.handle(searchIssues, search);
  return () => {};
}
```

Paseo owns the composer menu, search picker, selected pill, draft state, and submission. The `text` value is the complete snapshot sent to the agent.

## Hosts and lifecycle

Plugins are installed per daemon. When the same contribution exists on several connected hosts, Paseo shows one sidebar item and adds a host picker. The selected host supplies the bundle, Paseo API, RPC transport, and query cache. Calls never fall through to another host when the selected host is offline.

Attachment sources remain scoped to each composer's host.

Workspace panels and Command Center items stay scoped to the active host and exact cached context.
Reload replaces their registrations. Disable, removal, host disconnect, and evaluation failure
remove Command Center items and clear the installation's query state. An already-restored panel tab
remains as unavailable until its matching contribution returns or the user closes it. Panel render
failures stay inside the plugin error boundary.

## CLI reference

```bash
paseo plugin init /absolute/path/to/plugin
paseo plugin install /absolute/path/to/plugin
paseo plugin install /absolute/path/to/plugin --id another-runtime-id
paseo plugin add owner/repository
paseo plugin add https://git.example.com/owner/repository.git --ref main
paseo plugin add owner/monorepo:plugins/review
paseo plugin ls [id]
paseo plugin update <id>
paseo plugin update --all
paseo plugin reload my-plugin
paseo plugin logs my-plugin
paseo plugin disable my-plugin
paseo plugin enable my-plugin
paseo plugin remove my-plugin
```

`ls` reports runtime state, source details, and the installed commit without contacting the remote.
Use `update` when you want Paseo to contact a tracked Git remote and install an available update.

Put `--host <url>` before a management command when the target is not the CLI's default daemon. `remove`
never deletes a directory source; it deletes the managed checkout for a Git source. The install-time
`--id` is the runtime ID and allows the same directory or repository to be installed more than once.

> **Trust every plugin you add.** `paseo plugin add` and `paseo plugin install` mean “I trust this codebase.” Server code and Git preparation commands run unsandboxed with the daemon user's access on the daemon host; client contributions run inside Paseo. Dependencies and future updates are part of that decision. With the global `--host` option, commands run on the remote daemon host.

An existing directory wins over `owner/repository` GitHub shorthand. Append `:relative/path` when
the plugin lives below the repository root. Omit `--ref` to track the default branch. Explicit
branches track updates; tags and commits stay pinned.

Most plugins should omit `build`. Use it only when the staged checkout must install a dependency
that Paseo does not provide, generate source or assets, or perform another required preparation
step:

```json
{
  "id": "review",
  "requirements": { "paseo": ">=0.8.0" },
  "build": [
    ["npm", "ci"],
    ["npm", "run", "build"]
  ]
}
```

`build` is a list of non-empty argv arrays. Paseo runs each executable directly, without a shell,
from the staged plugin directory after resolving the exact commit and manifest. It never infers a
package manager or commands from lockfiles. Install and update both run `build` before validation,
compilation, activation, or replacement. A failing command reports its output, discards the
candidate, and leaves the installed/running version intact. The daemon log records each command and
output; with the global `--host` option, execution is on that daemon host.

Run `npm run typecheck` before install or reload. Never edit the daemon config directly.

The daemon-wide **Enable plugins** switch lives under **Settings → Plugins**. A configured plugin remains `disabled` until that switch and the plugin's own enabled state are both on.

The switch is the root `pluginsEnabled` field in `config.json`. After changing it, run `paseo reload --json`. Enabling starts every configured plugin whose own `enabled` value is not `false`; disabling tears down all plugins. No daemon restart is required. Manual edits to plugin source entries are not reloaded; use the plugin lifecycle commands for those.

## Load failures

Use `paseo plugin ls` to read the current status and error.

| Symptom                                                               | Check                                                                                                                                   |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `This plugin was made for an older version of Paseo`                  | The directory has only an `index.ts` entry. Follow the [migration guide](/docs/plugins/v0.8/migration).                                 |
| `Plugin entry points are missing`                                     | Neither `index.client.tsx` nor `index.server.ts` exists with that exact name.                                                           |
| `server-only module cannot be imported into the plugin client bundle` | Client code imports `server/` or a `*.server.*` file. Move the work behind an RPC and import its contract from `shared/`.               |
| `client-only module cannot be imported into the plugin server bundle` | Server code imports `client/` or a `*.client.*` file. Register that contribution from `index.client.tsx` instead.                       |
| `Node module cannot be imported into the plugin client bundle`        | Client code imports `node:*`. Move the operation to `server/` and call it through an RPC.                                               |
| Sidebar item is missing                                               | The plugin is `running`, the item references an existing surface, the icon name is valid, and the client is on the installation's host. |
| Client module is unavailable                                          | Import only the host-provided client modules listed above.                                                                              |
| RPC rejects                                                           | Check both Zod schemas and the daemon-side handler error.                                                                               |
| Edited code does not appear                                           | Run `npm run typecheck`, then `paseo plugin reload <id>`.                                                                               |
| Reload fails                                                          | Read `paseo plugin ls` and `paseo plugin logs <id>`, fix the source error, then reload; Paseo does not restore the previous bundle.     |
| Plugin exits unexpectedly                                             | Read `paseo plugin logs <id>` for retained initialization, cleanup, stderr, and final crash output.                                     |
