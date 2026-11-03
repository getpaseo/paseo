---
title: Plugin hooks
description: Register hooks to change requests or observe agent and workspace operations.
nav: Hooks
order: 48
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

Names follow `subject.operation.position`: the subject, the operation, then `before` or `after`. The name identifies a lifecycle position. Whether Paseo waits is a per-hook property shown in the table below. `workspace` covers every workspace; `worktree` covers only git worktrees.

- Waiting hooks finish before Paseo continues. Throwing, returning invalid data, or exceeding 30 seconds fails the operation with `Plugin <id> <hook> failed: …`. Request-changing hooks receive `{ request }` and may return a complete replacement request or `undefined`.
- Notifications receive the event object and return `Promise<void>`. Paseo does not wait; errors are logged against the plugin and the operation continues. `agent.turn.before` and `agent.permission.before` are notifications fired when a turn starts or a permission becomes pending.

All handlers must be async. Turn completion includes success, failure, and cancellation; inspect `outcome`. Permission completion includes every resolution; inspect `resolution`.

Creating an agent happens once, and `agent.create.before` changes its saved configuration. Opening starts the provider process: the first run, resume after a daemon restart, reading history, importing an outside session, or reload. `agent.open.before` contributes launch-only environment, tools, and MCP servers each time. Creating opens the agent; opening an existing agent does not create it; closing ends the running instance. Opening a tab in the app is a separate action.

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

| Hook                      | Waits | Payload                                | Handler may change                             |
| ------------------------- | ----- | -------------------------------------- | ---------------------------------------------- |
| `workspace.create.before` | yes   | `{ request }`                          | Entire create request                          |
| `workspace.create.after`  | no    | `{ workspace }`                        |                                                |
| `workspace.archive.after` | no    | `{ workspace }`                        |                                                |
| `worktree.create.before`  | yes   | `{ request }`                          | Creation options and destination               |
| `worktree.create.after`   | yes   | `{ worktree }`                         | Files in the worktree; throw to abort creation |
| `agent.create.before`     | yes   | `{ request: { config, env? } }`        | Saved config except `cwd`; `env`               |
| `agent.create.after`      | no    | `{ agent }`                            |                                                |
| `agent.open.before`       | yes   | `{ request }`                          | Launch-only `env`, `tools`, `mcpServers`       |
| `agent.close.after`       | no    | `{ agent }`                            |                                                |
| `agent.archive.after`     | no    | `{ agent, archivedAt }`                |                                                |
| `agent.turn.before`       | no    | `{ agent, turnId }`                    |                                                |
| `agent.turn.after`        | no    | `{ agent, turnId, outcome, timeline }` |                                                |
| `agent.permission.before` | no    | `{ agent, request }`                   |                                                |
| `agent.permission.after`  | no    | `{ agent, requestId, resolution }`     |                                                |

## Shared payloads

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

| Field        | Shape / meaning                                                                        |
| ------------ | -------------------------------------------------------------------------------------- |
| `turnId`     | Provider-reported `string` or `null`; can repeat after a session reopens               |
| `timeline`   | Deprecated, always `[]`; fetch history with the SDK.                                   |
| `request`    | SDK `AgentPermissionRequest`; `kind` is `tool`, `plan`, `question`, `mode`, or `other` |
| `resolution` | SDK `AgentPermissionResponse`                                                          |
| `archivedAt` | Timestamp string                                                                       |

## workspace.create.before

Receives `{ request }` with `source`, optional `title`, and `firstAgentContext`. You may replace the entire explicit create request; a throw, invalid result, or timeout fails creation. Existing workspaces and directory lookup/import are unaffected.

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

Ordering: `worktree.create.before` → `git worktree add` → `worktree.create.after` → workspace registration. Restoring a missing worktree recreates it at its recorded path without running either worktree creation hook.

## worktree.create.after

Paseo waits for this hook after a new git worktree exists and before workspace registration, setup, terminals, or agents. Receives `{ worktree: { path, branch, sourceCheckout } }`: the absolute worktree path, branch name, and source checkout directory. There is no workspace id yet. Return nothing; write files directly into the worktree. Throwing or exceeding 30 seconds aborts creation and removes the new worktree.

This covers branch-off, branch checkout, and PR checkout creation. Restoring a missing archived worktree uses a separate recovery path and does not fire this hook.

```ts
import { copyFile } from "node:fs/promises";

server.addHook("worktree.create.after", async ({ worktree }) => {
  await copyFile(`${worktree.sourceCheckout}/.env`, `${worktree.path}/.env`);
});
```

## agent.create.before

Receives `{ request: { config, env? } }`. Config changes are saved and remain after the plugin is disabled or removed; `env` applies to the initial launch and is not saved. You cannot change `config.cwd`. A throw, invalid result, or timeout fails creation.

**`agent.create.before.config`** uses `AgentSessionConfig`:

| Fields                                        | Constraint                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| `provider`, `model`                           | Separate fields; changing provider may require changing model/mode/options |
| `modeId`, `thinkingOptionId`, `featureValues` | Provider-specific selections                                               |
| `title`, `systemPrompt`                       | Agent configuration                                                        |
| `providerOptions`                             | Opaque provider-specific options                                           |
| `mcpServers`, `toolPolicy`                    | MCP configuration and exact-tool preapprovals                              |
| `cwd`                                         | Cannot change                                                              |

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

Receives `{ request }`; only `env`, `tools`, and `mcpServers` may change, for this launch. All other fields are read-only. A throw, invalid result, or timeout fails the open.

**`agent.open.before` request example:**

```json
{
  "agentId": "agent-123",
  "workspaceId": "workspace-456",
  "provider": "codex",
  "cwd": "/projects/shop",
  "title": "Workspace notes",
  "labels": { "notes/enabled": "true" },
  "tools": [],
  "mcpServers": {},
  "reason": "resume",
  "purpose": "interactive",
  "env": { "COMPANY_ENV": "development" }
}
```

| Field         | Values                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `workspaceId` | String or `null`                                                                                                        |
| `title`       | Read-only string or `null`; creation title on create, stored title on resume.                                           |
| `labels`      | Read-only string map; creation labels on create, stored labels on resume.                                               |
| `tools`       | Editable `AgentToolDefinition[]`, local to this plugin. See [Attach tools to agents](#attach-tools-to-agents).          |
| `mcpServers`  | Editable launch-only server map, local to this plugin. See [Inject MCP servers](#inject-mcp-servers).                   |
| `reason`      | `create`, `resume`, `refresh`, `import`                                                                                 |
| `purpose`     | `interactive`, `history`                                                                                                |
| `env`         | Launch override map; excludes the daemon's inherited environment. Replace the map to add, replace, or remove overrides. |

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
  if (request.provider !== "codex") return;

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
| Start, stop, or reload a plugin declaring `agent.open.before` | Open sessions become stale. Each reopens before its next idle prompt; a running turn continues without interruption. The next prompt after that reopen reuses the session.                                 |
| Change which agents the callback targets                      | Run `paseo plugin reload agent-tools` after editing this example, then send the agent a prompt when it is idle.                                                                                            |
| Apply immediately                                             | Call `await paseo.agents.ref(id).reload({ requestId: "reload-notes" })`. `requestId` is optional. This reopens the provider session, reruns hooks with `reason: "refresh"`, and interrupts a running turn. |
| Read the current snapshot                                     | Call `await paseo.agents.ref(id).refresh()`. This reads state without reopening the session.                                                                                                               |

If an automatic reopen fails, the triggering prompt fails with that error. See the
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

A live turn completes, fails, or is canceled. Receives `{ agent, turnId, outcome, timeline }`. `outcome.kind` is `completed`, `failed`, or `canceled`. `timeline` is deprecated and always empty; fetch history through the SDK as below.

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
    const page = await agent.timeline.refetch({ direction: "tail", limit: 20 });
    const text = latestOutputText(page.entries.map(({ item }) => item));
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

The handler fetches only the last 20 timeline items. Output before that page is not inspected.
Use `cursor` and `direction` to page further when your plugin needs more history.

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

Agent hooks exclude the daemon's private disposable helpers. Public background workspaces and their ordinary agents use the same hooks.

## Ordering and returned values

```text
Creation request
  → agent.create.before hooks (plugin-ID order; registration order within each plugin)
  → resolve defaults and validate provider configuration
  → derive launch configuration with Paseo runtime tools and daemon prompt
  → agent.open.before hooks (same ordering; env and plugin-local tools and MCP servers)
  → set PASEO_AGENT_ID and PASEO_AGENT_CWD
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

| Plugin                                                                                                 | Includes                                                                         |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| [lifecycle-logger](https://github.com/getpaseo/paseo/tree/main/plugin-examples/lifecycle-logger)       | Agent, workspace, and worktree hooks; JSON logs with environment values redacted |
| [lifecycle-actions](https://github.com/getpaseo/paseo/tree/main/plugin-examples/lifecycle-actions)     | Follow-ups, permissions, environment, provider switching, worktree selection     |
| [agent-configuration](https://github.com/getpaseo/paseo/tree/main/plugin-examples/agent-configuration) | MCP injection and Codex sandbox/approval options                                 |
| [agent-tools](https://github.com/getpaseo/paseo/tree/main/plugin-examples/agent-tools)                 | Label-targeted tools and file operations in the plugin process                   |

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
