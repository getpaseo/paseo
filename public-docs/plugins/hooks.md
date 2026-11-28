---
title: Plugin hooks
description: Register hooks to change requests or observe agent and workspace operations.
nav: Hooks
order: 49
category: Plugins
---

# Plugin hooks

Use `server.addHook(name, handler)` in `index.server.ts`. Hooks run while the plugin is enabled, even with no app connected. `addHook` is available from Paseo 0.14; set `requirements.paseo` to the release you build against.

```ts
import type { PluginServerContext } from "@getpaseo/plugin/server";

export default function contribute(server: PluginServerContext) {
  const remove = server.addHook("agent.open.before", async ({ request }) => ({
    ...request,
    env: { ...request.env, REGION: "eu" },
  }));
  return remove;
}
```

## Naming and timing

Names follow `subject.operation.position`: the subject, the operation, then `before` or `after`. The name identifies a lifecycle position. Whether Paseo waits is a per-hook property shown in the table below. `workspace` covers every workspace; `worktree` covers only git worktrees. `terminal` covers every terminal Paseo starts in a workspace; `command` covers worktree setup and teardown commands.

- Waiting hooks finish before Paseo continues. Throwing, returning invalid data, or exceeding 30 seconds fails the operation with `Plugin <id> <hook> failed: …`. Request-changing hooks receive `{ request }` and may return a complete replacement request or `undefined`.
- Notifications receive the event object and return `Promise<void>`. Paseo does not wait; errors are logged against the plugin and the operation continues. `agent.turn.before` and `agent.permission.before` are notifications fired when a turn starts or a permission becomes pending.

All handlers must be async. Turn completion includes success, failure, and cancellation; inspect `outcome`. Permission completion includes every resolution; inspect `resolution`.

Creating an agent happens once, and `agent.create.before` changes its saved configuration. Opening starts the provider process: the first run, resume after a daemon restart, reading history, importing an outside session, or reload. `agent.open.before` contributes launch-only environment, instructions, tools, MCP servers, and a launch wrap each time. Creating opens the agent; opening an existing agent does not create it; closing ends the running instance. Opening a tab in the app is a separate action.

`worktree.create.after` runs before the workspace is registered. It precedes `workspace.create.after`, and both precede the first agent's `agent.create.before` / `agent.open.before`.

### Return early from a waiting hook

Start detached work and return when the operation should continue immediately:

```ts
server.addHook("worktree.create.after", async ({ worktree }) => {
  void warmCaches(worktree.path);
});
```

Paseo only sees the returned promise, so detached work gets no error reporting and no cancellation `signal`.

## Hooks

| Hook                      | Waits | Payload                                                | Handler may change                                                     |
| ------------------------- | ----- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `workspace.create.before` | yes   | `{ request }`                                          | Entire create request                                                  |
| `workspace.create.after`  | no    | `{ workspace }`                                        |                                                                        |
| `workspace.archive.after` | no    | `{ workspace }`                                        |                                                                        |
| `worktree.create.before`  | yes   | `{ request }`                                          | Creation options and destination                                       |
| `worktree.create.after`   | yes   | `{ worktree }`                                         | Files in the worktree; throw to abort creation                         |
| `agent.create.before`     | yes   | `{ request: { config, env?, metadata, workspaceId } }` | Saved config except `cwd`; `env`; `metadata`                           |
| `agent.create.after`      | no    | `{ agent }`                                            |                                                                        |
| `agent.open.before`       | yes   | `{ request }`                                          | Launch-only `env`, `appendSystemPrompt`, `tools`, `mcpServers`, `wrap` |
| `agent.close.after`       | no    | `{ agent }`                                            |                                                                        |
| `agent.archive.after`     | no    | `{ agent, archivedAt }`                                |                                                                        |
| `agent.turn.before`       | no    | `{ agent, turnId }`                                    |                                                                        |
| `agent.turn.after`        | no    | `{ agent, turnId, outcome }`                           |                                                                        |
| `agent.permission.before` | no    | `{ agent, request }`                                   |                                                                        |
| `agent.permission.after`  | no    | `{ agent, requestId, resolution }`                     |                                                                        |
| `terminal.create.before`  | yes   | `{ request }`                                          | `env`, `wrap`; throw to refuse                                         |
| `command.run.before`      | yes   | `{ request }`                                          | `env`, `wrap`; throw to refuse                                         |

## Shared payloads

```ts
interface PluginHookAgent {
  id: string;
  workspaceId: string | null;
  parentAgentId: string | null;
  provider: string;
  cwd: string;
  title: string | null;
  readonly background: boolean;
  metadata: Record<string, JsonValue>;
}

interface PluginHookWorkspace {
  id: string;
  projectId: string;
  cwd: string;
  name: string | null;
  archivedAt: string | null;
  metadata: Record<string, JsonValue>;
}

type PluginTurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string; code?: string } }
  | { kind: "canceled"; reason: string };
```

| Field        | Shape / meaning                                                                        |
| ------------ | -------------------------------------------------------------------------------------- |
| `background` | `true` for a [background agent](#background-agents)                                    |
| `turnId`     | Provider-reported `string` or `null`; unique across resumed sessions                   |
| `timeline`   | Deprecated, always `[]`; fetch history with the SDK.                                   |
| `request`    | SDK `AgentPermissionRequest`; `kind` is `tool`, `plan`, `question`, `mode`, or `other` |
| `resolution` | SDK `AgentPermissionResponse`                                                          |
| `archivedAt` | Timestamp string                                                                       |

## Metadata

Agents and workspaces carry a `metadata` record for plugin data. Keys are strings, values are any JSON value, and Paseo stores the record without reading a key. Prefix keys with your plugin id so plugins do not collide. Labels stay strings for filtering and tagging; use metadata for structured data.

Set metadata when you create the agent or workspace, or change it later. `null` removes a key, and any other value replaces the key's whole value:

```ts
const agent = await paseo.agents.create({
  config: { provider: "codex/gpt-5.5" },
  cwd: "/projects/shop",
  metadata: { "linear.issue": { id: "ENG-123" } },
});

agent.metadata; // { "linear.issue": { id: "ENG-123" } }
await agent.setMetadata({ "linear.issue": null });
await paseo.workspaces.ref(workspaceId).setMetadata({ "linear.issue": { id: "ENG-123" } });
```

Metadata survives a daemon restart. Every hook payload carries it: `workspace.create.before` and `agent.create.before` receive the metadata the caller sent, and the `after` hooks and `agent.open.before` receive what is stored. Against a host that predates metadata, these calls throw "Update the host to use metadata."

## Launch wraps {#launch-wraps}

`agent.open.before`, `terminal.create.before`, and `command.run.before` can return `wrap: [executable, ...args]`, a `PluginLaunchWrap`. Paseo then starts the process as `[...wrap, command, ...args]`, for example under a sandbox:

```ts
import type { PluginLaunchWrap } from "@getpaseo/plugin/server";

const sandbox: PluginLaunchWrap = ["/usr/local/bin/sandbox-run", "--profile", "agent"];
```

- The executable must be an absolute path on the daemon host. Paseo runs it without a shell, except Windows `.cmd` and `.bat` launchers, which go through cmd.exe. Each element stays one argument.
- The first hook that returns a wrap selects it. A later hook, in the same plugin or a later one, may omit `wrap` or return the same value. A different value fails the operation.
- A wrap is never saved. Every launch asks the hooks again.
- A host that predates `wrap` rejects the field, so the operation fails instead of running unwrapped.

Each hook section below lists what its wrap covers.

## workspace.create.before

Receives `{ request }` with `source`, optional `title`, optional `metadata`, and `firstAgentContext`. You may replace the entire explicit create request; a throw, invalid result, or timeout fails creation. Existing workspaces and directory lookup/import are unaffected.

### Choose workspace isolation

```ts
server.addHook("workspace.create.before", async ({ request }) => {
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

## workspace.create.after

Fires after the workspace record is created and its directory is available. Receives `{ workspace }`.

```ts
server.addHook("workspace.create.after", async ({ workspace }) => {
  console.log(workspace);
});
```

## workspace.archive.after

Fires after archive state is saved. Receives `{ workspace }`; worktree cleanup can still be pending.

```ts
server.addHook("workspace.archive.after", async ({ workspace }) => {
  console.log(workspace);
});
```

## worktree.create.before {#worktreecreatebefore}

Choose the location and creation options for a new worktree. Paseo awaits this hook before `git worktree add`, on creation from the app, CLI, MCP, and agent creation. Receives `{ request }`; return a complete replacement request or `undefined` to keep it. Throwing, invalid returned data, or a 30-second timeout aborts creation with the plugin and hook named in the error.

```ts
import { basename, dirname, join } from "node:path";

server.addHook("worktree.create.before", async ({ request }) => ({
  ...request,
  path: join(
    dirname(request.sourceCheckout),
    `${basename(request.sourceCheckout)}.${request.branch.replaceAll("/", "-")}`,
  ),
}));
```

For source `/home/me/src/paseo` and branch `feature/x`, this creates `/home/me/src/paseo.feature-x`. See the complete [worktree-placement example](https://github.com/getpaseo/paseo/tree/main/plugin-examples/worktree-placement).

| Request field                             | Meaning                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                                    | `branch-off`, `checkout-branch`, `checkout-change-request`, or `checkout-github-pr`                                                               |
| `branch`                                  | Requested local branch name                                                                                                                       |
| `baseRef`                                 | Starting ref for branch-off; comparison base for change requests; absent for `checkout-branch`. To branch off a ref, return `kind: "branch-off"`. |
| `slug`                                    | Normalized worktree name                                                                                                                          |
| `path`                                    | Absolute destination; initially the default location with any existing-path suffix resolved                                                       |
| `repoRoot`                                | Read-only main repository root                                                                                                                    |
| `sourceCheckout`                          | Read-only source checkout root, including when creation starts from another worktree                                                              |
| `forge`, `changeRequestNumber`, `headRef` | Change-request checkout identity; GitHub legacy checkouts use `githubPrNumber` instead of `forge` and `changeRequestNumber`                       |
| `headRepositoryOwner`, `headRepository`   | Optional source repository facts; `headRepository` is present only on change-request checkouts                                                    |
| `checkoutRefs`                            | Optional fetch sources: `{ remoteName?: string, remoteRef: string }[]`                                                                            |
| `pushRemoteUrl`, `trackOriginHead`        | Optional push destination and tracking policy                                                                                                     |

Once `path` is returned, `slug` only feeds branch-off naming; the CLI looks up worktrees by the basename of their path.

Every field except `repoRoot` and `sourceCheckout` is transformable. Return all required facts for the chosen `kind`. Paseo resolves the Git source plan after this hook, so handlers can change the branch and base before fetching refs, while Git can still choose a unique final branch name afterward.

Paseo resolves symlinked parents and validates the returned path. It must be absolute, must not exist, and must not be the filesystem root, your home directory, the repository root, inside a `.git` directory, or an ancestor of the repository. An existing destination fails creation; Paseo never adds a suffix to a plugin-chosen path. The plugin must leave directory creation to Paseo.

Ordering: `worktree.create.before` → worktree manager `create` (or `git worktree add`) → `worktree.create.after` → workspace registration. To delegate `git worktree add`, removal, and restoration to an external tool such as Worktrunk, register a [worktree manager](/docs/plugins/reference#worktree-managers) with `server.registerWorktreeManager()` instead of creating directories inside `worktree.create.before`. Restoring a missing worktree recreates it at its recorded path without running creation hooks, delegating to the owning manager's optional `restore` handler when present.

## worktree.create.after

Paseo waits for this hook after a new git worktree exists and before workspace registration, setup, terminals, or agents. Receives `{ worktree: { path, branch, sourceCheckout } }`: the absolute worktree path, branch name, and source checkout directory. There is no workspace id yet. Return nothing; write files directly into the worktree. Throwing or exceeding 30 seconds aborts creation and removes the new worktree.

This covers branch-off, branch checkout, and PR checkout creation. Restoring a missing archived worktree uses a separate recovery path and does not fire this hook.

```ts
import { copyFile } from "node:fs/promises";

server.addHook("worktree.create.after", async ({ worktree }) => {
  await copyFile(`${worktree.sourceCheckout}/.env`, `${worktree.path}/.env`);
});
```

## terminal.create.before {#terminalcreatebefore}

Paseo waits for this hook before it starts a terminal in a workspace:

- **New terminal** and terminal profiles in the app, and terminals created through the CLI, SDK, and plugins
- terminals agents open with Paseo tools
- the terminals `paseo.json` scripts, services, and worktree terminals run in

Receives `{ request }`; return a replacement request or `undefined`. Only `env` and `wrap` may change. Throwing refuses the terminal, and whoever asked for it gets `Plugin <id> terminal.create.before failed: …`.

```ts
server.addHook("terminal.create.before", async ({ request }) => {
  if (!sandboxed.has(request.workspaceId)) return;
  return { ...request, wrap: ["/usr/local/bin/sandbox-run", "--profile", "terminal"] };
});
```

| Request field     | Meaning                                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspaceId`     | Read-only; the terminal's workspace                                                                                                                                           |
| `cwd`             | Read-only; where the terminal starts                                                                                                                                          |
| `source`          | Read-only. `agent`: an agent's Paseo tool. `script`: a `paseo.json` script or service. `worktree`: a `paseo.json` worktree terminal. `client`: the app, CLI, SDK, or a plugin |
| `name`            | Read-only; the tab name, or null                                                                                                                                              |
| `input`           | Read-only. For `script` and `worktree`, the command Paseo types into the shell once it starts; otherwise null                                                                 |
| `command`, `args` | Read-only; the program and its arguments. `command` is null for the default shell                                                                                             |
| `env`             | Variables Paseo adds to the terminal's environment                                                                                                                            |
| `wrap`            | Optional [launch wrap](#launch-wraps). Paseo starts `[...wrap, command, ...args]`; with no `command`, it puts the default shell after the wrap                                |

Scripts, services, and worktree terminals start the default shell and then type their command into it, so a wrap on the shell also covers what they run. A wrapped shell starts without Paseo's shell integration, so a wrapped `paseo.json` script does not report when its command finishes. A terminal that survives a daemon restart is adopted, not created again, and doesn't run the hook again. A plugin that creates a terminal from inside this hook runs the hook for that terminal too.

## command.run.before {#commandrunbefore}

Paseo waits for this hook before each `paseo.json` worktree `setup` and `teardown` command. Receives `{ request }`; return a replacement request or `undefined`. Only `env` and `wrap` may change. Throwing refuses the command: setup stops and reports the plugin's error, and teardown stops and keeps the worktree directory, as a failing command does.

```ts
server.addHook("command.run.before", async ({ request }) => ({
  ...request,
  wrap: ["/usr/local/bin/sandbox-run", "--profile", request.purpose],
}));
```

| Request field | Meaning                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspaceId` | Read-only; the workspace, or null when a worktree is archived by path and no workspace record remains                                           |
| `cwd`         | Read-only; where the command runs                                                                                                               |
| `purpose`     | Read-only; `setup` or `teardown`                                                                                                                |
| `command`     | Read-only; the command as written in `paseo.json`. Paseo runs it with `bash -c` on macOS and Linux, and with PowerShell or `cmd.exe` on Windows |
| `env`         | Variables Paseo adds to the daemon's environment: `PASEO_SOURCE_CHECKOUT_PATH`, `PASEO_WORKTREE_PATH`, `PASEO_BRANCH_NAME`, and the rest        |
| `wrap`        | Optional [launch wrap](#launch-wraps). Paseo starts the shell behind it: `[...wrap, "bash", "-c", command]` on macOS and Linux                  |

Setup starts after the workspace is registered and `workspace.create.after` is emitted, and runs alongside the first agent. When setup runs again, such as from **Run setup** on a worktree whose setup was blocked, each command runs the hook again. Teardown runs when the last workspace on a worktree is archived, before Paseo removes the directory.

## agent.create.before

Receives `{ request: { config, env?, metadata, workspaceId } }`. Config and `metadata` changes are saved and remain after the plugin is disabled or removed; `env` applies to the initial launch and is not saved. You cannot change `config.cwd` or `workspaceId`. A throw, invalid result, or timeout fails creation.

`workspaceId` is the workspace the agent is created in, or null. Use it rather than `config.cwd` to find the workspace: several workspaces can share a directory, and an agent can be created in one workspace with a directory inside another.

**`agent.create.before.config`** uses `AgentSessionConfig`:

| Fields                       | Constraint                                                                 |
| ---------------------------- | -------------------------------------------------------------------------- |
| `provider`, `model`          | Separate fields; changing provider may require changing model/mode/options |
| `modeId`, `thinkingOptionId` | Provider-specific selections                                               |
| `title`, `systemPrompt`      | Agent configuration                                                        |
| `providerOptions`            | Provider options, including speed and auto-accept selections               |
| `mcpServers`, `toolPolicy`   | MCP configuration and exact-tool preapprovals                              |
| `cwd`                        | Cannot change                                                              |

### Change saved configuration

Add this callback inside `contribute(server)` to set the saved options for new Codex agents:

```ts
server.addHook("agent.create.before", async ({ request }) => {
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
    },
  };
});
```

| Input                                       | Result                  |
| ------------------------------------------- | ----------------------- |
| `providerOptions.sandbox_mode: "read-only"` | `"workspace-write"`     |
| `providerOptions.web_search: "disabled"`    | Preserved by the spread |

The selected provider validates `providerOptions`. Explicit Codex sandbox and approval options
override its mode presets.

## agent.create.after

Ordinary creation finishes. Receives `{ agent }`; import and resume do not fire it.

```ts
server.addHook("agent.create.after", async ({ agent }) => {
  console.log(agent);
});
```

## agent.open.before

Receives `{ request }`; only `env`, `appendSystemPrompt`, `tools`, `mcpServers`, and `wrap` may change, for this launch. All other fields are read-only. A throw, invalid result, or timeout fails the open.

Do not await a write to the agent being opened: `setMetadata`, `setLabels`, or an option, model, thinking or mode change. The write waits for the open to finish, the open waits for your hook, so the hook times out and the open fails. Start the write without awaiting it; it runs right after the open:

```ts
server.addHook("agent.open.before", async ({ request }, { paseo }) => {
  void paseo.agents
    .ref(request.agentId)
    .setMetadata({ "my.plugin": { openedBy: "hook" } })
    .catch((error) => console.error(error));
});
```

**`agent.open.before` request example:**

```json
{
  "agentId": "agent-123",
  "workspaceId": "workspace-456",
  "provider": "codex",
  "cwd": "/projects/shop",
  "title": "Workspace notes",
  "background": false,
  "labels": { "notes/enabled": "true" },
  "metadata": { "linear.issue": { "id": "ENG-123" } },
  "tools": [],
  "mcpServers": {},
  "reason": "resume",
  "purpose": "interactive",
  "env": { "COMPANY_ENV": "development" }
}
```

| Field         | Values                                                                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspaceId` | String or `null`                                                                                                                                      |
| `title`       | Read-only string or `null`; creation title on create, stored title on resume.                                                                         |
| `background`  | Read-only `true` for a [background agent](#background-agents). Fixed at creation.                                                                     |
| `labels`      | Read-only string map; creation labels on create, stored labels on resume.                                                                             |
| `metadata`    | Read-only JSON map; the [metadata](#metadata) stored on the agent.                                                                                    |
| `tools`       | Editable `AgentToolDefinition[]`, local to this plugin. See [Attach tools to agents](#attach-tools-to-agents).                                        |
| `mcpServers`  | Editable launch-only server map, local to this plugin. See [Inject MCP servers](#inject-mcp-servers).                                                 |
| `reason`      | `create`, `resume`, `refresh`, `import`                                                                                                               |
| `purpose`     | `interactive`, `history`                                                                                                                              |
| `env`         | Launch override map; excludes the daemon's inherited environment. Replace the map to add, replace, or remove overrides.                               |
| `wrap`        | Optional [launch wrap](#launch-wraps) to start the harness behind. See [Run the harness behind a launch wrap](#run-the-harness-behind-a-launch-wrap). |

### Run the harness behind a launch wrap

Return a [launch wrap](#launch-wraps) to start the provider's harness as `[...wrap, command, ...args]`:

```ts
server.addHook("agent.open.before", async ({ request }) => ({
  ...request,
  wrap: ["/usr/local/bin/sandbox-run", "--profile", "agent"],
}));
```

- A provider applies a wrap when its provider snapshot entry has `launchWrap: true`. Every built-in provider and every custom ACP provider does. A plugin provider does when it declares support, as Muse Code and the ACP plugin providers such as Antigravity do. Read the field with `paseo.providers.snapshot()` in `agent.create.before` and choose a provider there. A wrap for any other provider fails the open; it is never dropped.
- History opens keep the wrap.
- A wrapped OpenCode session gets its own OpenCode server, which starts behind the wrap. An OpenCode provider configured to use an existing server cannot start one, so a wrapped open fails.
- The harness does not always start in the agent's directory. Codex starts it in the daemon's directory, and OpenCode starts its server in the `opencode-home` directory under the Paseo home. Both send the session directory over their protocol. If your launcher needs the directory, put `request.cwd` in the wrap's arguments.
- Keep the system temp directory visible inside the wrap. Paseo writes the Pi extension there before it starts Pi, and Claude Code writes its tool output there. A launcher that hides it behind an empty private directory breaks those sessions.
- The wrap covers the processes that Paseo starts for the session: the harness, the stdio MCP servers that Paseo hosts for the agent, and the terminals that an ACP agent asks Paseo to run. Paseo's host terminal tools, provider availability and catalog probes, and draft discovery run outside it.

### Append instructions on every session opening

```ts
server.addHook("agent.open.before", async ({ request }) => ({
  ...request,
  appendSystemPrompt: [...(request.appendSystemPrompt ?? []), "Follow the team engineering guide."],
}));
```

Instructions follow the saved agent prompt and daemon instructions, in plugin order. They are not saved in the agent configuration and are ignored for history opens. Reload the plugin after changing its data to apply new instructions on the next reopen. Running turns continue; removing an instruction does not remove conversation history. Internal agents also receive these instructions. The ACP adapter does not send system instructions to its providers. Plugin providers receive the composed prompt, but must apply it themselves.

Codex instruction updates require Codex 0.121.0 or newer with a recognizable version reported by the app server. Source builds reporting `0.0.0` must use a versioned build. Paseo adds a current instruction snapshot to existing threads; earlier snapshots remain in the conversation. A crash during an update or rewinding a thread can repeat a snapshot.

### Inject environment variables on every session opening

```ts
server.addHook("agent.open.before", async ({ request }) => {
  return {
    ...request,
    env: {
      ...request.env,
      COMPANY_ENV: "development",
    },
  };
});
```

Session-open overrides are re-derived on every open. `agent.create.before.env` applies only to the
initial launch and is not saved in the agent's configuration.

### Inject MCP servers

Use `agent.create.before.config.mcpServers` when the server should become part of the agent's saved
configuration. For a plugin-owned server, add this callback inside `contribute(server)`, replacing
the placeholder URL with your MCP endpoint:

```ts
server.addHook("agent.open.before", async ({ request }) => {
  if (request.provider !== "codex" || request.background) return;

  return {
    ...request,
    mcpServers: {
      ...request.mcpServers,
      company: { type: "http", url: "https://tools.example.com/mcp" },
    },
  };
});
```

`request.mcpServers` uses the same server configurations as `AgentSessionConfig.mcpServers`.
The map starts empty for each plugin and accumulates across that plugin's own callbacks. It never
contains the agent's saved servers or another plugin's servers. Replace the map to add, replace,
or remove this plugin's entries; returning `undefined` preserves it. Paseo merges the plugins'
final maps in plugin-ID order.

A name colliding with a saved server, Paseo's internal `paseo` server, or another plugin's server
fails the session open and names the server and both sources. A provider without MCP support fails
with `does not support MCP servers`, naming the plugin. Opens with `purpose: "history"` ignore
these servers. Install, disable, and reload changes reach existing agents through the
[session reopen behavior](#attach-tools-to-agents).

### Attach tools to agents

Define a tool in `index.server.ts` and attach it in `server.addHook("agent.open.before", async handler)`.
This example gives `append_workspace_note` only to agents with the label `notes/enabled: "true"`:

```ts
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineAgentTool, type PluginServerContext } from "@getpaseo/plugin/server";

const appendWorkspaceNote = defineAgentTool({
  name: "append_workspace_note",
  description: "Append a note to AGENT_NOTES.md in this agent's working directory.",
  input: z.object({ note: z.string().min(1).describe("Note to append") }),
  async execute({ note }, { agent, signal }) {
    const notePath = path.join(agent.cwd, "AGENT_NOTES.md");
    await writeFile(notePath, `${note}\n`, { encoding: "utf8", flag: "a", signal });
    return {
      text: `Saved note to ${notePath}`,
      structuredContent: { path: notePath },
    };
  },
});

export default function contribute(server: PluginServerContext) {
  server.addHook("agent.open.before", async ({ request }) => {
    if (request.labels["notes/enabled"] !== "true") return;
    return { ...request, tools: [...request.tools, appendWorkspaceNote] };
  });
  return () => {};
}
```

Set the label when creating an agent with the SDK:

```ts
const agent = await paseo.agents.create({
  config: { provider: "codex/gpt-5.4" },
  cwd: "/projects/shop",
  labels: { "notes/enabled": "true" },
});
```

Select agents using any of the session-open request fields:

| Select by        | Condition in the callback                    |
| ---------------- | -------------------------------------------- |
| Label            | `request.labels["notes/enabled"] === "true"` |
| Provider         | `request.provider === "codex"`               |
| Workspace        | `request.workspaceId === "workspace-456"`    |
| Individual agent | `request.agentId === chosenAgentId`          |
| Background agent | `request.background`                         |

`request.tools` starts empty for each plugin. Each callback sees the tools returned by earlier
callbacks in that plugin; replace the array to add or remove tools. Returning `undefined` preserves
the request. Tools are ignored for `purpose: "history"`.

Import `defineAgentTool`, `AgentToolDefinition`, `AgentToolContext`, and `AgentToolResult` from
`@getpaseo/plugin/server`. The helper infers the validated input from your Zod schema:

```ts
declare function defineAgentTool<Input extends z.ZodType>(tool: {
  name: string;
  title?: string;
  description: string;
  input: Input;
  execute(
    input: z.output<Input>,
    context: AgentToolContext,
  ): AgentToolResult | Promise<AgentToolResult>;
}): AgentToolDefinition;

interface AgentToolResult {
  text?: string;
  structuredContent?: unknown;
  isError?: boolean;
}
```

| Execution context | Value                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `agent`           | Calling agent as a `PluginHookAgent`, including `id`, `workspaceId`, `provider`, `cwd`, and `title` |
| `paseo`           | SDK connected to this daemon                                                                        |
| `signal`          | Abort signal for this tool call; pass it to file operations or external requests                    |

`execute` runs in the plugin process. Closures and the original Zod schema stay there; only tool
metadata and call inputs/results cross the process boundary. Paseo validates input before calling
`execute`. Invalid input returns schema issues to the agent. A thrown error becomes
`{ isError: true, text: message }` and the plugin keeps running. Canceling the call or closing its
transport aborts `signal` and discards the result. Tool calls have a 10 minute ceiling, separate
from the 30 second hook timeout. Closing or reopening an agent session drops its old definitions.

Return model-visible text in `text`. `structuredContent` must be JSON-serializable; when `text` is
omitted, Paseo formats that value as text for the model. Set `isError: true` to report a tool error.

Paseo delivers attached tools through its agent tool transport, using MCP or native registration
as the provider supports. The same definition and callback work with either. Attached tools obey
the [same gates as Paseo tools](/docs/mcp#limit-paseo-tools-by-provider). Only that agent sees them.

Names must match `/^[a-z][a-z0-9_]*$/` and be at most 64 characters. A name colliding with a Paseo
tool or another plugin's tool on the same agent fails the session open and names both owners.
A duplicate name within one plugin also fails the session open. Agents the callback does not
target are unaffected.

| Change                                                        | When the agent receives it                                                                                                                                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start, stop, or reload a plugin declaring `agent.open.before` | Before the session's next agent tool call or prompt, as described below.                                                                                                                                   |
| Change which agents the callback targets                      | Run `paseo plugin reload agent-tools` after editing this example, then send the agent a prompt when it is idle.                                                                                            |
| Apply immediately                                             | Call `await paseo.agents.ref(id).reload({ requestId: "reload-notes" })`. `requestId` is optional. This reopens the provider session, reruns hooks with `reason: "refresh"`, and interrupts a running turn. |
| Read the current snapshot                                     | Call `await paseo.agents.ref(id).refresh()`. This reads state without reopening the session.                                                                                                               |

When a plugin declaring `agent.open.before` starts, stops, or reloads, Paseo reruns that plugin's
callback for each open session, before the session's next agent tool call or prompt. The callback
gets the request it saw at the session's last open, with `reason: "refresh"` and the agent's current
title, workspace, labels, and metadata. A later plugin in the chain also reruns when the env or
instructions it receives change. Other callbacks do not run.

A reload counts as one change. A tool call or prompt during the reload waits for the plugin to
start, so the session does not lose the plugin's tools in between. If the plugin fails to start,
the session continues as if the plugin stopped.

- The tools the callback returns replace its old tools at once, also during a running turn. The new
  plugin instance answers the calls.
- If the env, instructions, MCP servers, tool definitions, or the plugin that provides a tool
  differ from what the session launched with, the session reopens before its next idle prompt. A running turn continues without interruption.
  A callback whose result depends on `reason` always differs from a `create` open. Reverting the
  change before that prompt cancels the reopen.
- If nothing differs, the session keeps running with its background work and subagents. A plugin
  that does not target the agent leaves it as it is.
- If the callback throws or times out, its tools stay off, and the session reopens before its next
  idle prompt. Paseo does not rerun it for the same plugin instance.
- If a returned tool collides with a Paseo tool or another plugin's tool, that plugin's tools stay
  off, and the session reopens before its next idle prompt.
- If two plugins return the same MCP server name, both plugins keep their agent tools, but the reopen
  before the next idle prompt fails with the collision error.

Agents that receive Paseo tools natively (OpenCode with the bridge, OMP) keep the tool list they
launched with until the reopen. Their calls to a listed tool reach the new instance of the plugin
that attached it, and fail if that plugin no longer attaches it.

If an automatic reopen fails, the triggering prompt fails with that error. The session keeps
running with the tools it had, and each later idle prompt tries the reopen again. See the
[complete agent-tools example](https://github.com/getpaseo/paseo/tree/main/plugin-examples/agent-tools).

## agent.close.after

A live agent runtime closes. Receives `{ agent }`.

```ts
server.addHook("agent.close.after", async ({ agent }) => {
  console.log(agent);
});
```

## agent.archive.after

Archive state is saved. Receives `{ agent, archivedAt }`; runtime cleanup can still be pending.

```ts
server.addHook("agent.archive.after", async ({ agent, archivedAt }) => {
  console.log(agent, archivedAt);
});
```

## agent.turn.before

A live turn starts. Receives `{ agent, turnId }`. History replay does not fire it.

```ts
server.addHook("agent.turn.before", async ({ agent, turnId }) => {
  console.log(agent, turnId);
});
```

## agent.turn.after

A live turn completes, fails, or is canceled. Receives `{ agent, turnId, outcome }`. `outcome.kind` is `completed`, `failed`, or `canceled`. The payload carries no history. Read the turn from the agent's timeline: `refetch({ direction: "tail", limit: 1, wholeTurns: true })` returns the latest turn whole, as below. Keep the entries whose `turnId` equals `event.turnId`, because a turn that starts before your read, such as a follow-up another plugin sent, replaces this one as the latest. The filtered list is empty in that case, and when `event.turnId` is `null`. Plugins built against an older SDK that read `event.timeline` get an empty array.

### Send a follow-up when a turn ends

Copy [server/inspect.ts](https://github.com/getpaseo/paseo/blob/main/plugin-examples/lifecycle-actions/server/inspect.ts)
into your plugin. The helper imports types from `@getpaseo/protocol/agent-types`; add
`@getpaseo/protocol` at the version matching your daemon to your development dependencies
and install them before loading the plugin. `latestOutputText` joins text chunks after the latest user message.

```ts
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { latestOutputText } from "./server/inspect";

export default function contribute(server: PluginServerContext) {
  server.addHook("agent.turn.after", async (event, context) => {
    if (event.outcome.kind === "canceled") {
      return;
    }

    const agent = context.paseo.agents.ref(event.agent.id);
    const page = await agent.timeline.refetch({ direction: "tail", limit: 1, wholeTurns: true });
    const turn = page.entries.filter((entry) => entry.turnId === event.turnId);
    const text = latestOutputText(turn.map(({ item }) => item));
    if (/out of credits/i.test(text)) {
      await agent.send("Try again.");
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

## agent.permission.before

A permission or question becomes pending. Receives `{ agent, request }`; `request` is an `AgentPermissionRequest`. Send the answer through the SDK.

### Answer a permission request

Using `shellCommand` from the same [helper file](https://github.com/getpaseo/paseo/blob/main/plugin-examples/lifecycle-actions/server/inspect.ts):

```ts
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { shellCommand } from "./server/inspect";

export default function contribute(server: PluginServerContext) {
  server.addHook("agent.permission.before", async (event, context) => {
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

## agent.permission.after

A pending request is answered or cleared. Receives `{ agent, requestId, resolution }`; `resolution` is an `AgentPermissionResponse`.

```ts
server.addHook("agent.permission.after", async ({ agent, requestId, resolution }) => {
  console.log(agent, requestId, resolution);
});
```

## Background agents

Agent hooks exclude the daemon's private disposable helpers. Background agents and the agents in background workspaces use the same hooks.

A [background agent](/docs/sdk/agents#run-a-helper-as-a-background-agent) is a helper hidden from tabs, lists and attention. Every hook's `agent.background` and the `agent.open.before` request's `background` are `true` for one, so you can skip it without a lookup:

```ts
server.addHook("agent.turn.after", async ({ agent }) => {
  if (agent.background) return; // A helper reports to the agent that created it.
  await notifyTeam(agent);
});
```

`background` is fixed when the agent is created and a hook cannot change it. An agent created in a background workspace without `background: true` reads `false`. Hosts older than 0.16.0 omit the field, so it reads as `undefined`.

## Ordering and returned values

```text
Creation request
  → agent.create.before hooks (plugin-ID order; registration order within each plugin)
  → resolve defaults and validate provider configuration
  → derive launch configuration with Paseo runtime tools and daemon prompt
  → agent.open.before hooks (same ordering; env and plugin-local tools and MCP servers)
  → set PASEO_AGENT_ID, PASEO_AGENT_CWD, and PASEO_WORKSPACE_ID when the agent has a workspace
  → open provider session and save agent configuration
```

| Callback returns                                        | Next callback receives                              |
| ------------------------------------------------------- | --------------------------------------------------- |
| `{ ...request, env: { ...request.env, REGION: "eu" } }` | Prior request with `REGION` added/replaced          |
| `{ ...request, env: { REGION: "eu" } }`                 | Prior request with the entire override map replaced |
| `undefined`                                             | Unchanged request                                   |
| Throws or returns invalid data                          | Operation fails; later callbacks do not run         |

There is no automatic deep merge. `env` accumulates across plugins; `tools` and `mcpServers`
accumulate only across callbacks within the same plugin. Returning a replacement map or array
replaces that scope's prior value.

## Context and cleanup

| Contract                           | Behavior                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `context.paseo`                    | Existing SDK connected to this daemon                                                                            |
| `context.signal`                   | Aborted on invocation timeout or plugin stop; pass to external requests                                          |
| Input data                         | Detached snapshot; change state through returned requests or SDK commands                                        |
| Registration result                | Idempotent remover, e.g. `const remove = server.addHook(...); remove();`                                         |
| Reload, disable, removal, shutdown | Remaining registrations removed                                                                                  |
| Unknown hook name                  | Registration fails                                                                                               |
| Hook timeout                       | 30 seconds; aborts the signal. A waiting hook fails the pending operation; a notification handler logs an error. |
| Event-handler error                | Logged against plugin; original operation continues                                                              |
| Event delivery                     | Live, best effort; no replay, persistence, or automatic retry                                                    |
| Event concurrency                  | Different events may overlap; callback completion order is not guaranteed                                        |

## Complete examples

| Plugin                                                                                                 | Includes                                                                                            |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| [lifecycle-logger](https://github.com/getpaseo/paseo/tree/main/plugin-examples/lifecycle-logger)       | Agent, workspace, worktree, terminal, and command hooks; JSON logs with environment values redacted |
| [lifecycle-actions](https://github.com/getpaseo/paseo/tree/main/plugin-examples/lifecycle-actions)     | Follow-ups, permissions, environment, provider switching, worktree selection                        |
| [agent-configuration](https://github.com/getpaseo/paseo/tree/main/plugin-examples/agent-configuration) | MCP injection and Codex sandbox/approval options                                                    |
| [agent-tools](https://github.com/getpaseo/paseo/tree/main/plugin-examples/agent-tools)                 | Label-targeted tools and file operations in the plugin process                                      |
| [worktrunk](https://github.com/getpaseo/paseo/tree/main/plugin-examples/worktrunk)                     | Worktree manager (`create`, `remove`, `restore`) and agent activity markers                         |

Read logger output with `paseo plugin logs lifecycle-logger` or the host's `daemon.log`.

## Renamed hooks

The old registration methods are deprecated for removal after 2027-04-30. Existing plugins keep their behavior. Mixed old and new registrations within a plugin run in registration order. `addHook` accepts only the new names.

| Old registration                                   | New registration                                          |
| -------------------------------------------------- | --------------------------------------------------------- |
| `server.before("workspace.create", handler)`       | `server.addHook("workspace.create.before", asyncHandler)` |
| `server.on("workspace.created", handler)`          | `server.addHook("workspace.create.after", asyncHandler)`  |
| `server.on("workspace.archived", handler)`         | `server.addHook("workspace.archive.after", asyncHandler)` |
| `server.before("agent.create", handler)`           | `server.addHook("agent.create.before", asyncHandler)`     |
| `server.on("agent.created", handler)`              | `server.addHook("agent.create.after", asyncHandler)`      |
| `server.before("agent.session_open", handler)`     | `server.addHook("agent.open.before", asyncHandler)`       |
| `server.on("agent.closed", handler)`               | `server.addHook("agent.close.after", asyncHandler)`       |
| `server.on("agent.archived", handler)`             | `server.addHook("agent.archive.after", asyncHandler)`     |
| `server.on("agent.turn_started", handler)`         | `server.addHook("agent.turn.before", asyncHandler)`       |
| `server.on("agent.turn_ended", handler)`           | `server.addHook("agent.turn.after", asyncHandler)`        |
| `server.on("agent.permission_requested", handler)` | `server.addHook("agent.permission.before", asyncHandler)` |
| `server.on("agent.permission_resolved", handler)`  | `server.addHook("agent.permission.after", asyncHandler)`  |
