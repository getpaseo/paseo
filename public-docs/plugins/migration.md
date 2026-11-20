---
title: Migrate a plugin
description: Move to adaptive session contributions or migrate older mixed entries to client and server entries.
nav: Migration
order: 48
category: Plugins
---

# Migrate a plugin

Use the adaptive migration below for optional per-session features. For plugins written for Paseo
0.7 or earlier, start with [runtime entry migration](#1-classify-the-existing-code), introduced in 0.8.

Give this page to a coding agent with the plugin directory as its working directory. Execute the
applicable migration in order. Do not keep a compatibility entry.

## Adaptive session contributions (source contract)

This contract is source-only. No released host/SDK minimum has been assigned. Existing package
versions or manifest requirements do not establish support, and this guide is not an installation
or release-readiness claim. Before publication, align the plugin dependency/lockfile and
`requirements.paseo` with the real host/SDK release that supplies these APIs. Do not invent a version
or commit local absolute `file:` dependencies.

Check the host feature once during synchronous server setup, before registering adaptive hooks:

```ts
export default function contribute(server: PluginServerContext) {
  if (!server.features?.adaptiveAgentFeatures) {
    throw new Error("Update the Paseo host to use adaptive plugin features.");
  }
  // Register this plugin's recipe and open hooks here.
  return () => {};
}
```

Import `PluginServerContext` from `@getpaseo/plugin/server`. Do not maintain a second create-hook
implementation for old hosts. Existing old plugins retain their established behavior; an upgraded
adaptive plugin needs the feature-bearing host.

Move optional instructions, tools, MCP bindings, exact approval conveniences, environment, and
provider options out of `agent.create.before` and into `agent.open.before`. Derive each independent
feature from current preferences and `openSupport` on every interactive open. Keep preferences,
stored plugin data, helper routing, and per-call permission checks unchanged. Unknown support
omits only the optional feature that depends on it; do not retry startup with reduced caller
requirements. See the [hook contract](./hooks.md#resolve-optional-features-for-this-opening) for
support, merge precedence, and launch-resource ownership.

### Coexist with saved contributions

Moving the hook does not remove contributions already saved by the old create hook. Register one
static `server.registerLegacyAgentConfig({ version: 1, selectors: [...] })` recipe during synchronous
setup. The host binds it to the installed runtime plugin ID. Duplicate or late registration fails.
Each selector has an `id`, `group`, and `label`, plus its field-specific selector:

| `kind`           | Exact selection                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp`            | `name` of a saved server.                                                                                                                                 |
| `prompt-suffix`  | Literal `text`; optional `followedBySuffix` lists exact known trailing variants.                                                                          |
| `prompt-section` | Literal `start` and `end` markers around one well-formed section.                                                                                         |
| `grant`          | Exact `server` and `tool`.                                                                                                                                |
| `option` / `env` | Top-level `key` and named `baselines`, each with `id`, `label`, and `kind: "absent"` or `kind: "value"` plus `value`. Environment values must be strings. |

Recipes contain no callbacks, regular expressions, arbitrary paths, owner assertions, or expected
secrets. Names and literal matches nominate candidates, not authority to remove caller state.
Do not guess overwritten caller baselines. An absent baseline means inherit current defaults,
not recover the historical value.

Use `baseConfig` and `legacyConfigState.selectors` to suppress conflicting additions before
allocating credentials. Selector states are `present`, `absent`, or `ambiguous`, not provenance.

| Required base for one feature group                                      | New optional contribution                                                                                              |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Saved endpoint remains, including a coincidentally named caller endpoint | Preserve it; add no replacement endpoint, dependent instructions, environment, or grants. Never claim its credentials. |
| Endpoint adopted but matching saved instructions remain                  | Derive eligible tools only if their names are free; preserve the text and append no duplicate guidance.                |
| Endpoint remains but instructions adopted                                | Suppress the endpoint's whole dependent group; do not describe an unowned binding.                                     |
| Prompt match is ambiguous                                                | Preserve caller text and suppress fresh guidance for that group; explain the ambiguity.                                |
| Plugin preference is Off, but saved values remain unadopted              | Add nothing new. Off does not erase saved values; existing per-call safety controls still apply.                       |
| Group fully adopted or absent                                            | Derive eligible contributions for this opening. Independent groups remain independent.                                 |

Do not strip text by heading, rotate a legacy credential, infer ownership from a server name, or
auto-approve a saved binding. A blocked adoption must not itself prevent an otherwise valid legacy
chat from opening with its unchanged required configuration.

### Explicitly adopt or reset one saved agent

Adoption means excluding selected old fragments from the required launch base so the current plugin
can derive eligible replacements. It does not erase originals, rewrite plugin data, or prove that
an old endpoint is live. There is no automatic migration.

Use [CLI preview/apply/reset](/docs/cli#saved-plugin-configuration) or the
[SDK agent operations](/docs/sdk/agents#saved-plugin-configuration). All three operations require
`workspace.write` and `server_info.features.adaptiveAgentFeatures`. Preview reads the exact saved
agent without opening a provider, running hooks, minting credentials, or unarchiving it. It returns
candidate labels, consequences, blocked reasons, baseline IDs, receipt IDs, and an expected-state
fingerprint, not raw prompts, credential URLs/headers, environment values, or option values.

Select candidates explicitly. Option and environment candidates require an explicit baseline ID;
leaving a candidate unselected keeps it unadopted. Required, mixed caller/plugin, and unmarked
policies cannot be reclassified by adoption. A dependent endpoint is blocked too. Plugin-only
policy adoption requires exact known grants and selection of every reference to an adopted server.
There is no policy-release override.

Apply and reset compare a fresh preview fingerprint against current saved state. A changed recipe,
configuration, receipt set, or daemon restart can make it stale: preview again, do not force it.
Mutations reject running agents and uncertain closure. An idle live session becomes stale for its
next legitimate open; neither command reloads it or interrupts a turn. Results say
`appliesOn: "next-open"`.

If an adopted fragment changes, projection fails with reset-first guidance. Explicit edits to an
adopted option key also require reset first, even if the new value equals the old value. Reset the
affected receipt before editing, then preview again if you want to adopt the revised fragment.
Unrelated edits preserve valid selections; prompt selections bind to the whole original prompt,
so editing that prompt requires resetting its affected selections first.

Reset removes only selected receipts. The next open uses the retained original intent, even if the
plugin is disabled. Reset preview does not require a running plugin. Review that restored intent
before reopening; reset is not a request to disable the old integration.
If resetting a grant receipt would leave a dependent endpoint receipt unusable, reset both together.
The error names the dependent endpoint receipts; it never expands your selection automatically.
Reset still permits incremental recovery from already stale or broken receipt sets.

**Before downgrading a host:** reset and review adoption receipts with the feature-bearing host.
An older host may ignore receipts and reactivate the retained original additions. Do not assume
cross-downgrade execution parity. Already copied drafts or independently saved schedule templates
are not retroactively reconstructed by adoption.

Older-app option display and the updated app's explicit safe-copy opt-in are owned by
[protocol compatibility](../../docs/protocol-compatibility.md). Updating an SDK alone does not
assert that its consuming app uses the new copy flow.

### Verification before release

Exercise supported, limited, and supported-again openings, failed replacement cleanup, fixed-binding
retention, unadopted/partial adoption, blocked policy, reset, and caller-name collisions in isolated
fixtures. Compare durable preferences/data and original saved intent, not just startup success.
The source contract does not establish actual provider behavior or rendered availability states.
Real-provider smoke, actual render/platform checks, and release metadata alignment remain separate
release gates; they are not reported as completed by this guide. Current provider-specific limits
are listed in [the provider guide](./providers.md#current-source-verification-limits).

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

| Old registration and location                                                                 | New registration and location                                                                                                                                 |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin.handle(contract, handler)` in the old root entry                                      | `server.handle(contract, handler)` in `index.server.ts`                                                                                                       |
| `plugin.addSurface(id, Component)` in the old root entry                                      | `client.addScreen({ id, title, Component })` in `index.client.tsx`                                                                                            |
| `plugin.addSidebarItem({ id, title, icon, surface })` in the old root entry                   | `client.addSidebarHeaderItem({ id, title, Component })` in `index.client.tsx`; see [sidebar items](reference#sidebar-items)                                   |
| New sidebar footer contribution                                                               | `client.addSidebarFooterItem({ id, title, Component })` in `index.client.tsx`                                                                                 |
| New sidebar replacement view                                                                  | `client.addSidebarView({ id, title, Component })` in `index.client.tsx`; see [sidebar views](sidebar-views)                                                   |
| New badge on sidebar workspace rows                                                           | `client.addWorkspaceRowBadgeItem({ id, title, icon, Component })` in `index.client.tsx`; see [workspace row badge items](reference#workspace-row-badge-items) |
| New file panel contribution                                                                   | `client.addFilePanel(panel)` in `index.client.tsx`                                                                                                            |
| `plugin.addWorkspacePanel(panel)` in the old root entry                                       | `client.addWorkspacePanel(panel)` in `index.client.tsx`                                                                                                       |
| Agent panel with `context: "agent"`                                                           | `client.addAgentPanel(panel)` in `index.client.tsx`; omit `context`                                                                                           |
| `plugin.addCommandCenterItem(item)` in the old root entry                                     | `client.addCommandCenterItem(item)` in `index.client.tsx`                                                                                                     |
| `plugin.addClientSlashCommand(command)` in the old root entry                                 | `client.addSlashCommand(command)` in `index.client.tsx`                                                                                                       |
| `plugin.addClientSide(fn)` in the old root entry                                              | Delete the wrapper and move the body of `fn` into the default client entry function                                                                           |
| `client.addComposerPill(pill)` inside the old client callback                                 | `client.addComposerPill(pill)` inside `index.client.tsx` or an imported `client/` function                                                                    |
| New composer item contribution                                                                | `client.addComposerItem(item)` in `index.client.tsx`; see [composer items](reference#composer-items)                                                          |
| New New workspace item contribution                                                           | `client.addNewWorkspaceItem(item)` in `index.client.tsx`; see [New workspace items](reference#new-workspace-items)                                            |
| New header contribution                                                                       | `client.addHeaderButton({ id, workspaceId, button })`                                                                                                         |
| `plugin.addAttachmentSource(source)` in the old root entry                                    | `client.addAttachmentSource(source)` in `index.client.tsx`                                                                                                    |
| New settings screen contribution                                                              | `client.addSettingsScreen(screen)` in `index.client.tsx`; see [settings screens](reference#settings-screens)                                                  |
| `plugin.addTheme(theme)` in the old root entry                                                | `client.addTheme(theme)` in `index.client.tsx`                                                                                                                |
| `plugin.addTimelineTransformer(transformer)` in the old root entry                            | `client.addTimelineTransformer(transformer)` in `index.client.tsx`                                                                                            |
| `plugin.addTimelineRenderer(renderer)` in the old root entry                                  | `client.addTimelineRenderer(renderer)` in `index.client.tsx`                                                                                                  |
| `import { defineRpc, defineAttachmentSource } from "@getpaseo/plugin/server"` in shared files | `import { defineRpc, defineAttachmentSource } from "@getpaseo/plugin"`                                                                                        |
| `ZodOutput<typeof contract.input>` handler parameter types                                    | `RpcInput<typeof contract>` from `@getpaseo/plugin`; `RpcOutput` for return types                                                                             |

Register the screen that replaces an `addSidebarItem` under that item's `id` to keep saved links
working. A `/plugin/<plugin>/sidebar/<id>` link, and the older `/plugin/<plugin>/<id>`, opens the
`addSidebarItem` with that `id`, or else the screen with that `id`.

Import `PluginClientContext` from `@getpaseo/plugin/client` and `PluginServerContext` from
`@getpaseo/plugin/server`. Remove imports of the old context type. Client registrations return idempotent removal functions, except header buttons and composer pills, which return `{ update, remove }` handles. Preserve any remover the plugin calls before teardown; Paseo removes outstanding
registrations after the entry cleanup runs.

### Panel props in 0.13

All panel kinds share [params, revision, and persisted tab state](./reference.md#workspace-panels).

| Previous API                                                            | Replacement                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------ |
| Workspace/agent `context` prop                                          | Select the kind at registration.                 |
| Agent `agentId` prop                                                    | `params.agentId`                                 |
| `addWorkspacePanel({ context: "workspace", ... })`                      | `addWorkspacePanel({ ... })`                     |
| `addWorkspacePanel({ context: "agent", ... })`                          | `addAgentPanel({ ... })`                         |
| Beta file `location.lineStart`, `location.lineEnd`, `location.revision` | `params.lineStart`, `params.lineEnd`, `revision` |
| Beta `PluginFileTab`, `PluginFileLocation`                              | `PluginTab`, `PluginFilePanelParams`             |

The 0.12 aliases remain available until removal after 2027-04-23. The beta file API changes
outright. Declare `requirements.paseo` as `>=0.13.0` when adopting the new API.

### Composer pills

Update the plugin project's `@getpaseo/plugin` dependency, then run `npm run typecheck`.
The old contribution is missing the required `button` field, `PluginComposerPillProps` is no longer
exported, and calling the new registration as a function is a TypeScript error. A project pinned
to the old SDK still checks against the old contract; installing or reloading a plugin does not
run TypeScript's type checker.

Replace the pill's `Component` with `button.icon` and `button.label`, move `title` into `button`,
and move `onPress` into `button.behavior`. Cleanup changes from calling the returned function to
calling its `.remove()` method.

```tsx
const pill = client.addComposerPill({
  id: "review",
  workspaceId,
  agentId,
  button: {
    title: "Open review",
    icon: "Scan",
    label: "Review",
    behavior: { kind: "action", onPress: openReview },
  },
});

pill.update({ label: "Review · 3", visible: true });
// Client entry cleanup:
pill.remove();
```

Move dynamic text from the former component into updates from your model or SDK subscription.
Custom icon components may still use hooks. Composer pills always show icon and label; menus and
popovers add a chevron. See [buttons](./reference.md#button-descriptor) for menus, popovers, and visibility.

## 4. Separate imports

Move hooks (`usePaseo`, `useRpc`, `useSettings`, `useAgent`, `useWorkspace`) and client contribution
types from `@getpaseo/plugin` to `@getpaseo/plugin/client`. Move `Icon` to
`@getpaseo/plugin/client/ui`. Import server contexts and lifecycle contracts from
`@getpaseo/plugin/server`. Shared helpers (`defineRpc`, `defineSettings`, `defineAttachmentSource`),
schemas, and plain data types stay on the root. These rules include type imports. See
[Runtime modules](reference#runtime-modules) for the complete contract.

Move the remaining SDK subpaths under their runtime owner:

| Old entry                              | Current entry                      |
| -------------------------------------- | ---------------------------------- |
| `@getpaseo/plugin/react-native`        | `@getpaseo/plugin/client/ui`       |
| `@getpaseo/plugin/client/react-native` | `@getpaseo/plugin/client/ui`       |
| `@getpaseo/plugin/ui`                  | `@getpaseo/plugin/client/ui`       |
| `@getpaseo/plugin/provider`            | `@getpaseo/plugin/server/provider` |
| `@getpaseo/plugin/acp`                 | `@getpaseo/plugin/server/acp`      |

The pre-0.8 entries and the old `@paseo/plugin` scope are removed. `/client/host` is private to
Paseo's app integration and is never a plugin-author import.

The client entry imports only `client/`, `shared/`, and client-safe packages. The server entry imports
only `server/`, `shared/`, and server-safe packages. A `node:` import in the client entry or anything
reachable from it is a compile error. Never import a component into the server entry merely to wire
its registration; that registration belongs in the client entry.

### UI imports in v0.13

Use `/client/ui` for all Paseo UI components and UI hooks. The deprecated
`/client/react-native` entry retains `useRevealedText(text, phase): string` for 0.12 plugins
until removal after 2027-04-20. The hook is deprecated and is not exported from `/client/ui`.

For paced timeline text, replace `useRevealedText(text, phase)` and the surrounding `Text` with
`<StreamedText text={text} phase={phase} style={style} />` from `/client/ui`.
Use `SettingsSection` for plugin settings headings; `SettingsGroup` is deprecated.

### Provider options in v0.15

A provider plugin has one configuration record, `providerOptions`, and describes which keys get a
composer control. A provider that still reports `settings` keeps working through v0.15: Paseo reads each
setting `id` as an option key and each `value` as that option, and sends changes in both
`changes.providerOptions` and `changes.settings`. Remove `settings` before the shim is deleted after
2027-05-01.

| Previous API                                   | Replacement                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| `session.config` `settings: ProviderSetting[]` | `controls: ProviderOptionControl[]` plus `providerOptions`                 |
| Setting `id`                                   | Control `key`                                                              |
| Setting `value`                                | `providerOptions[key]`; the control holds no value                         |
| Select setting `options: { label, value }[]`   | Select control `choices: { value, label, description? }[]`                 |
| Setting with no icon or default                | Control `icon` (a Lucide name) and `defaultValue`                          |
| `session.configure` `changes.settings`         | `changes.providerOptions`; `null` returns a key to its default             |
| `session.open` `config.settings`               | `config.providerOptions`                                                   |
| `ProviderSetting` type                         | `ProviderOptionControl`                                                    |
| `agent.create.before` `config.featureValues`   | `config.providerOptions`; a returned `featureValues` edit is still applied |

### Turn history in v0.16

`agent.turn.after` has sent an empty `timeline` since v0.13, and the SDK type no longer declares it.
A plugin that reads `event.timeline` now fails typecheck. Read the turn from the agent instead:

```ts
const turn = await context.paseo.agents
  .ref(event.agent.id)
  .timeline.refetch({ direction: "tail", limit: 1, wholeTurns: true });
const items = turn.entries.filter((entry) => entry.turnId === event.turnId).map(({ item }) => item);
```

The filter drops entries from a turn that started after this one ended, such as a follow-up another plugin sent. The list is empty when such a turn has already started, or when `event.turnId` is `null`.

Plugins built against an older SDK keep receiving `timeline: []` until removal after 2027-05-31.

## 5. Recognize half-migration errors

| Compiler or load error                                                                                                     | Meaning and fix                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `This plugin has no requirements.paseo`                                                                                    | Complete the migration and declare the range in step 7.                                                                   |
| `This plugin was made for an older version of Paseo`                                                                       | The directory still has only the old root entry. Create a runtime entry, move registrations, then delete the old file.    |
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
import type { PluginClientContext } from "@getpaseo/plugin/client";
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
import type { PluginServerContext } from "@getpaseo/plugin/server";
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

## 7. Declare the Paseo requirement

After migrating the entries and imports, add the minimum runtime version to `paseo-plugin.json`:

```json
{
  "id": "my-plugin",
  "requirements": { "paseo": ">=0.8.0" }
}
```

Keep your existing ID and build commands. Missing `requirements.paseo` means `<0.8.0`, so Paseo 0.8 and later
reject the plugin even if its files have been moved. Adding the field alone does not migrate the
code. Update the local `@getpaseo/plugin` development dependency to the version you target and
reinstall dependencies before typechecking.

See [requirements](reference#requirements) for range and prerelease semantics.

## 8. Verify the migration

Run:

```bash
npm run typecheck
paseo plugin reload <plugin-id>
paseo plugin ls
```

Require `running` with no error. Exercise every contribution. For plugins with RPCs, call the client
action and verify the server result. For client-only plugins, confirm the contribution loads without
a server process. Call any stored registration remover twice and verify the second call is a no-op.
