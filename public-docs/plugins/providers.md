---
title: Build a provider plugin
description: Add a coding agent to Paseo directly or adapt an ACP agent.
nav: Provider plugins
order: 46
category: Plugins
---

# Build a provider plugin

Start with the [plugin quickstart](/docs/plugins) if you have not built a Paseo plugin before.

A provider plugin connects a coding agent to Paseo without adding it to Paseo core. [Publish the plugin](/docs/plugins/publishing) on npm or in a Git repository so users can
install it with `paseo plugin install`.

Choose one implementation path:

| Agent                                                             | Path                                                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| It already implements ACP                                         | Register it with `runAcpProvider()` and add only narrow vendor transformers. |
| It has a TypeScript SDK, JSON-RPC API, or custom process protocol | Implement `ProviderRegistration` directly.                                   |

The examples are:

- [`provider-direct`](https://github.com/getpaseo/paseo/tree/main/plugin-examples/provider-direct): sessions, option controls, prompts, persistence, child sessions, and a provider-owned timeline renderer;
- [`provider-acp-transformer`](https://github.com/getpaseo/paseo/tree/main/plugin-examples/provider-acp-transformer): an ACP command template with a Zod-validated vendor edit transformer. Replace `example-acp --stdio` with an installed ACP agent before loading it;
- [`inline-thinking`](https://github.com/getpaseo/paseo/tree/main/plugin-examples/inline-thinking): a renderer-only plugin that does not implement a provider.

## Register a direct provider

Add a server entry:

```ts
// index.server.ts
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createProvider } from "./server/provider";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createProvider());
  return () => {};
}
```

`createProvider()` returns one `ProviderRegistration`:

```ts
import {
  negotiateProviderCapabilities,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";

const supported = ["prompt.message"] as const;

export function createProvider(): ProviderRegistration {
  return {
    id: "my-agent",
    label: "My agent",
    icon: "icon.svg",
    async connect(request) {
      const capabilities = negotiateProviderCapabilities(request.capabilities, supported);
      return createConnection(capabilities);
    },
  };
}
```

The connection has three operations:

- `send(input)` accepts work and returns. Results are events, not return values.
- `onEvent(listener)` publishes session state and complete timeline snapshots.
- `close()` stops every session and releases processes, subscriptions, and pending work.

Keep the native SDK, process, and stream inside the connection implementation. Convert its output
to `ProviderEvent` objects before publishing it.

## Launch the provider CLI

Use `spawnProcess` and `execCommand` from `@getpaseo/plugin/server` for process transports
and CLI probes. Both handle Windows `.cmd`/`.bat` launchers and quote shell arguments.
Raw Node `spawn` and `execFile` reject those launchers on Windows.

The daemon supplies `request.launch` with the resolved command, argument prefix, and complete
environment. Pass that environment explicitly; the helpers do not apply daemon environment policy.
Keep the process lifecycle and protocol deadlines inside your provider. End stdin for graceful
shutdown; use `terminateProcess(child)` for a forced stop. It kills the process tree on Windows,
including the CLI behind a command-script launcher. Bound your final wait for closed streams.

```ts
import { spawnProcess, execCommand } from "@getpaseo/plugin/server";

const child = spawnProcess(launch.command, [...launch.args, "serve"], {
  env: launch.env,
  cwd,
  stdio: "pipe",
});
const { stdout } = await execCommand(launch.command, [...launch.args, "--version"], {
  env: launch.env,
  timeout: 5000,
});
```

### Run sessions behind a launch wrap

A [launch wrap](./hooks.md#launch-wraps) from `agent.open.before` reaches your provider as
`session.open`'s `config.wrap`. To support it:

1. Set `launchWrap: true` on the registration. Paseo publishes `launchWrap: true` in the provider
   snapshot, so plugins can choose your provider before it connects.
2. Add `session.launch_wrap` to the connection's supported capabilities. Paseo sends `config.wrap`
   only to a connection that negotiated it, and fails a wrapped open on any other connection.
3. Start the session's process with the `wrap` option. `spawnProcess` then starts
   `[...wrap, command, ...args]` and handles Windows launchers for the wrap's executable:

```ts
const child = spawnProcess(launch.command, [...launch.args, "serve"], {
  wrap: input.config.wrap,
  env: launch.env,
  cwd: input.config.cwd,
  stdio: "pipe",
});
```

Start every process that does the session's work behind the wrap. If one process serves several
sessions, start a separate one for a wrapped session. `runAcpProvider({ command })` does all of this
for an ACP agent.

## Return models, modes, and thinking options

Paseo requests the catalog before creating a session. Return the choices needed by the agent form:

```ts
if (input.type === "catalog") {
  emit({
    type: "catalog",
    requestId: input.requestId,
    catalog: {
      models: [
        { id: "agent-large", label: "Agent Large" },
        { id: "agent-small", label: "Agent Small" },
      ],
      modes: [
        { id: "build", label: "Build" },
        { id: "plan", label: "Plan" },
      ],
      thinkingOptions: [
        { id: "standard", label: "Standard" },
        { id: "extended", label: "Extended" },
      ],
      defaultModel: "agent-large",
      defaultMode: "build",
      defaultThinkingOption: "standard",
    },
  });
}
```

Return an empty array for a category the agent does not expose. The selected `model`, `mode`, and
`thinkingOption` arrive in the session configuration.

The catalog describes choices available before a session exists. Session-specific controls come
later through `session.config`.

### Stop a request Paseo cancels

Paseo gives each catalog refresh a deadline. When it stops waiting for a request, it sends
`request.cancel` with that request's `requestId`. Stop the work and release what it started, such
as a process you spawned to read the catalog. Paseo ignores any event you emit for that request
afterward. Sessions on the same connection keep running.

Add `request.cancel` to your supported capabilities. Paseo sends the input only to a connection
that offers it:

```ts
const pending = new Map<string, AbortController>();

if (input.type === "catalog") {
  const controller = new AbortController();
  pending.set(input.requestId, controller);
  void readCatalog({ signal: controller.signal })
    .then(
      (catalog) => {
        if (!controller.signal.aborted)
          emit({ type: "catalog", requestId: input.requestId, catalog });
      },
      (error) => {
        if (!controller.signal.aborted)
          emit({
            type: "request.failed",
            requestId: input.requestId,
            error: { message: String(error) },
          });
      },
    )
    .finally(() => pending.delete(input.requestId));
}
if (input.type === "request.cancel") {
  pending.get(input.requestId)?.abort();
}
```

A cancel can arrive after the request finished. Ignore a `requestId` you no longer track.
`runAcpProvider` offers the capability and stops the catalog probe's process.

## Open a session

`session.open` contains the complete launch configuration: working directory, environment, system
prompt, MCP servers, tool policy, model, mode, `providerOptions`, and persistence
preference.

For persisted host-scoped plugin settings, use the handle returned by `server.registerSettings()`.
Read it in catalog and session callbacks, and subscribe when the provider keeps in-memory
configuration. See [settings](./reference.md#persisted-values) for the `read()` and `subscribe()`
contract.

Create the native session with the selected catalog values, then publish its effective state:

```ts
const nativeSession = await sdk.createSession({
  cwd: input.config.cwd,
  model: input.config.model,
  mode: input.config.mode,
  thinking: input.config.thinkingOption,
  systemPrompt: input.config.systemPrompt,
  env: input.config.env,
  mcpServers: input.config.mcpServers,
});

emit({
  type: "session.opened",
  requestId: input.requestId,
  sessionId: input.sessionId,
  capabilities: ["prompt.message"],
  restoration: "core",
  cwd: input.config.cwd,
});
emit({
  type: "session.config",
  sessionId: input.sessionId,
  config: {
    model: nativeSession.model,
    mode: nativeSession.mode,
    thinkingOption: nativeSession.thinking,
    models,
    modes,
    thinkingOptions,
    controls: [],
    providerOptions: {},
  },
});
emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
```

`session.config` contains the committed values. Publish what the native agent selected after
normalization, not a copy of the request.

## Complete the first prompt

Start with message prompts. Advertise `prompt.message`, pass the content to the native agent, and
publish the resulting lifecycle:

```ts
const turnId = crypto.randomUUID();

emit({
  type: "timeline.item",
  sessionId,
  item: {
    type: "user_message",
    id: `user:${turnId}`,
    text,
    clientMessageId: prompt.clientMessageId,
  },
});
emit({
  type: "session.prompt_result",
  sessionId,
  clientMessageId: prompt.clientMessageId,
  result: { type: "turn", turnId },
});
emit({ type: "session.turn", sessionId, turnId, state: "started" });

// Publish complete snapshots as native output changes.
emit({
  type: "timeline.item",
  sessionId,
  item: { type: "assistant_message", id: `assistant:${turnId}`, text: completeText },
});

emit({ type: "session.turn", sessionId, turnId, state: "completed" });
```

Publish exactly one `session.prompt_result` for each `clientMessageId`. Copy `clientMessageId` onto
the user timeline item so Paseo replaces its optimistic message. Every started turn needs one
terminal `completed`, `failed`, or `canceled` event.

At this point the provider is usable: users can select a model, open a session, send a message, and
see the response.

## Add composer controls for provider options

`providerOptions` is the provider's own configuration: one record of JSON values that Paseo
stores per agent and hands to `session.open`. It includes the defaults a user set in `config.json`
for your provider. Validate every key you read.

Add `controls` only when users should see and change some of those options in the composer. A
control draws one top-level key of `providerOptions` as a toggle or a select. It holds no value:
Paseo reads the value from `providerOptions`. Publish the controls and the values you run with in
`session.config`:

```ts
emit({
  type: "session.config",
  sessionId,
  config: {
    model: "agent-large",
    models: [{ id: "agent-large", label: "Agent Large" }],
    modes: [],
    thinkingOptions: [],
    controls: [
      { type: "toggle", key: "fast", label: "Fast mode", icon: "Zap", defaultValue: false },
      {
        type: "select",
        key: "approval",
        label: "Approvals",
        icon: "Shield",
        defaultValue: "ask",
        choices: [
          { value: "ask", label: "Ask" },
          { value: "auto", label: "Auto accept" },
        ],
      },
    ],
    providerOptions: { fast: nativeSession.fast, approval: nativeSession.approval },
  },
});
```

`icon` is a Lucide icon name. `defaultValue` is what a control shows for a key that has no value.
Paseo stores every value you report when a session opens or a change is applied, including values
at the default and values nobody set. The same controls appear in the New workspace screen, in draft
tabs, and on running agents. Offer a control only for a key you can change on a running session.
The provider may change its controls at runtime, including after a model change.

A change arrives as `session.configure` with `changes.providerOptions` holding only the keys
that changed, whether or not they have a control. Apply every key and publish the committed
`session.config` before `request.completed`. Fail the request with `request.failed` and leave
every key as it was when you cannot apply one, for example a key you read only when a session
opens. A
value of `null` returns that key to the provider's default. Publish what the session ended up
with, not a copy of the request: Paseo stores your published values so the stored options match
what runs.

If the provider changes an option on its own, for example a model switch turns Fast off, publish
a new `session.config` with the new values. Paseo stores them and does not set the old ones
back.

Not every option needs a control. A provider-specific token budget, for example, belongs in
`providerOptions` and is not a dedicated prompt field. It is delivered in `session.open`, a caller
can change it on a running agent, and your `session.configure` handler decides whether it can
apply it live. Report it in `providerOptions` so Paseo stores what runs.

## Add persistence and replay

Advertise `session.persistence` when a native session can be reopened. Open a new native session
when `session.open.persistence` is absent. Resume the identified native session when it is present.
Return an opaque persistence value in `session.opened` or `session.persistence`; Paseo stores it
without inspecting it.

When `history` is `"replay"`, publish the native session's existing `timeline.item` snapshots before
`session.ready`. Use `history: "skip"` to open without replaying old rows.

Archived chats use a separate read-only callback so opening history never calls `session.open`:

```ts
readSessionHistory: async ({ persistence, cwd, env, launch }) => ({
  items: await readStoredTimeline({ persistence, cwd, env, launch }),
  coverage: { kind: "complete" },
}),
```

The callback must read persisted data without registering an interactive session. Return complete
`timeline.item` snapshots in provider order. Providers without this callback do not support
archived history reads; Paseo does not fall back to `session.open`. If the provider stores child
sessions, return them in `children` with their direct parent, tool call, metadata, and complete
timeline snapshots. Use `parentSessionId: null` for children of the managed session and the
provider child ID for nested children. Paseo turns these records into the normal provider-subagent
timeline without opening an interactive child session.

Paseo refreshes an agent by closing its current provider session and opening it again with current
configuration and persistence. Re-read credentials, environment, global configuration, and MCP
servers during `session.open`. There is no separate reload operation.

Conversation and combined rewind require a core-restored session with persistence. After a
successful rewind, Paseo closes the session and reopens its latest persistence value with
`history: "replay"`. Publish the retained native branch before `session.ready`, including its
children. File-only rewind keeps the current session and conversation history.

Use `restoration: "core"` when Paseo can reopen a session from persistence. A provider-owned child
uses `restoration: "parent"`; emit it as another `session.opened` event with `parentSessionId` and
recreate it while restoring the parent.

## Add commands and steering

All user input arrives through `session.prompt`:

- `input.type: "message"` carries text, images, and attachments;
- `input.type: "command"` carries a selected command and its arguments;
- `delivery: "steer"` asks you to add input to the active turn;
- `delivery: "auto"` lets you start a turn or complete a command without one.

Publish `session.commands` to add structured commands to the composer. A command can start a normal
turn or finish as a side effect with a `completed` prompt result.

Advertise only capabilities you implement. If steering is unsupported, omit `prompt.steer`; Paseo
can replace the active turn instead.

## Permit idle runtime cleanup

Paseo can release an idle resumable session after one hour when its daemon baseline allows cleanup.
Add a provider-owned veto by advertising `session.can_stop_runtime` on the connection and the
session's `session.opened` capabilities. Without this capability, the same baseline and one-hour
idle period apply, and the plugin receives no safety request.

Handle the safety query in your existing `send(input)` handler. It addresses the provider's own
session ID, including when one connection serves several sessions:

```ts
case "session.can_stop_runtime": {
  try {
    const session = sessions.get(input.sessionId);
    if (!session) throw new Error("Session not found");
    emit({
      type: "session.can_stop_runtime",
      requestId: input.requestId,
      sessionId: input.sessionId,
      canStop: await session.canStopRuntime(),
    });
  } catch (error) {
    emit({
      type: "request.failed",
      requestId: input.requestId,
      error: { message: error instanceof Error ? error.message : String(error) },
    });
  }
  return;
}
```

`canStopRuntime(): Promise<boolean>` belongs to your provider's session implementation. Return
`true` only when releasing the runtime loses no background shells, monitors, native children,
queued completion reports, or pending autonomous replies. This query must not stop or mutate the
session. Return `false` while work remains. A rejected query, invalid response, or timeout also
keeps the runtime alive. Never respond with `request.completed` for this query.

Paseo always checks foreground work, permissions, queued deliveries, lifecycle operations,
working managed/native descendants, and outstanding local or remote finish subscriptions for the
caller. Subscription protection lasts through registration, recovery and notification dispatch
acknowledgment. A positive provider response never overrides these blockers. Paseo rechecks
activity before the existing `session.close` operation. After protected work finishes, a fresh
one-hour idle period starts. The saved provider persistence must resume the same conversation.
The host setting `agents.idleRuntimeCleanup: false` disables collection for every provider.

## Publish timeline items

Publish complete snapshots through `timeline.item`. Reuse an item `id` when updating streamed text,
a running tool, or a todo list. Paseo derives the live delta and keeps the normal timeline.

Built-in item types cover user and assistant messages, reasoning, tools, todos, errors,
notifications, and compaction. Use a plugin item when your provider has a presentation that those
types cannot express:

```ts
emit({
  type: "timeline.item",
  sessionId,
  item: {
    type: "plugin",
    id: "review-42",
    pluginId: "my-provider-plugin",
    kind: "review-verdict",
    version: 1,
    data: { verdict: "ship", summary: "All checks passed" },
  },
});
```

Register the renderer independently in `index.client.tsx`:

```tsx
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { z } from "zod";
import { ReviewVerdict } from "./client/review-verdict";

const reviewVerdictSchema = z.object({
  verdict: z.enum(["ship", "hold"]),
  summary: z.string(),
});

export default function contribute(client: PluginClientContext) {
  client.addTimelineRenderer({
    kind: "review-verdict",
    version: 1,
    schema: reviewVerdictSchema,
    Component: ReviewVerdict,
  });
  return () => {};
}
```

The same renderer can display items emitted by a provider, a client timeline transformer, or a
daemon timeline append. A renderer does not require a provider implementation.

## Report metrics

Report what your provider measured as `label` and `value` pairs. Paseo shows each value as given,
so format it for reading: `12.4s`, not `12431`. You choose which metrics make sense for your agent.

Add `metrics` to the `completed` turn event. Paseo shows them from the footer of that turn:

```ts
emit({
  type: "session.turn",
  sessionId,
  turnId,
  state: "completed",
  metrics: [
    { label: "Model", value: "example-1" },
    { label: "Elapsed", value: "12.4s" },
    { label: "Tokens", value: "18.9K ↑ · 2.3K ↓" },
    { label: "Cache", value: "82%", tone: "ok" },
  ],
});
```

Publish `session.metrics` for totals that cover the whole session. Paseo shows them in the context
window details. Each event replaces the previous list, and an empty list clears it. Add
`session.metrics` to your supported capabilities and publish the event only when it was negotiated:

```ts
if (capabilities.includes("session.metrics")) {
  emit({
    type: "session.metrics",
    sessionId,
    metrics: [
      { label: "Turns", value: "7" },
      { label: "Cost", value: "$0.42" },
    ],
  });
}
```

A Paseo from before session metrics does not offer the capability and closes a connection that
sends the event. It ignores `metrics` on a turn, so turn metrics need no check.

Set `tone` to `"ok"`, `"warning"`, or `"danger"` to color a value. When a completed turn has no
`Model` metric, Paseo adds the session's model.

When `history` is `"replay"`, publish each old turn's `completed` event after that turn's items.
Paseo puts the metrics back on the turn's footer.

## Report installation and updates

Add `installation` to your registration and the provider's settings show an **Installation**
section. Users see whether your CLI is installed and which version, whether an update is
available, and an **Update** button that runs your updater and shows its output. Every member is
optional, so declare only what your CLI supports:

| Member            | Users see                                                               | Declare it when                                        |
| ----------------- | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| `installUrl`      | **Install instructions**, and **Install** while not installed           | Users install a CLI                                    |
| `updateUrl`       | **Update instructions** while installed, when you declare no `update`   | Your docs say how to update                            |
| `inspect`         | **Version**, or **Not installed**                                       | The CLI reports its version                            |
| `checkForUpdates` | **Up to date**, **Update available**, or **Couldn't check for updates** | You can ask the release source your CLI's updater uses |
| `update`          | **Update** while installed, then the updater's output                   | The CLI updates itself with a command                  |

This `example-agent` prints its version, asks `self-update --check --json` for the release its
updater installs, and updates with `self-update`:

```ts
import { execCommand, spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type {
  ProviderInstallation,
  ProviderInstallationLaunch,
} from "@getpaseo/plugin/server/provider";

async function run(launch: ProviderInstallationLaunch, args: string[], signal: AbortSignal) {
  const { stdout } = await execCommand(launch.command, [...launch.args, ...args], {
    env: launch.env,
    timeout: 20_000,
    signal,
  });
  return stdout.trim();
}

export const installation: ProviderInstallation = {
  installUrl: "https://example.com/docs/install",
  updateUrl: "https://example.com/docs/update",

  async inspect({ launch, signal }) {
    if (!launch?.resolved) return { status: "not_installed" };
    // `example-agent --version` prints `1.4.2`.
    return { status: "installed", version: await run(launch, ["--version"], signal) };
  },

  async checkForUpdates({ launch, installedVersion, signal }) {
    if (!launch) return { status: "unknown" };
    // Prints `{"latest":"1.5.0"}`; `self-update` installs any release that differs.
    const { latest } = JSON.parse(
      await run(launch, ["self-update", "--check", "--json"], signal),
    ) as { latest: string };
    return latest === installedVersion
      ? { status: "current" }
      : { status: "available", versions: [latest] };
  },

  async update({ launch, signal, report }) {
    if (!launch?.resolved) return { status: "failed", message: "example-agent is not installed" };
    const child = spawnProcess(launch.command, [...launch.args, "self-update"], {
      env: launch.env,
      stdio: "pipe",
    });
    child.stdin.end();
    child.stdout.on("data", (chunk: Buffer) => report({ type: "stdout", text: chunk.toString() }));
    child.stderr.on("data", (chunk: Buffer) => report({ type: "stderr", text: chunk.toString() }));
    const stop = () => void terminateProcess(child);
    signal.addEventListener("abort", stop, { once: true });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }).finally(() => signal.removeEventListener("abort", stop));
    if (code !== 0) return { status: "failed", message: `self-update exited with code ${code}` };
    return { status: "succeeded", message: "New sessions use the new version." };
  },
};
```

Add it to the registration next to `command`:

```ts
export function createProvider(): ProviderRegistration {
  return {
    id: "example-agent",
    label: "Example Agent",
    command: ["example-agent"],
    installation,
    async connect(request) {
      // ...
    },
  };
}
```

Each callback receives the launch a session would use. When `launch.resolved` is `false`, Paseo did
not find the executable and `command` is the configured name, so report `not_installed` without
running it. `launch` is absent when the registration declares no `command`. `checkForUpdates` runs
only after `inspect` reports the CLI installed, and receives the `version` it reported as
`installedVersion`, so compare that instead of reading the version again. For an ACP provider,
spread `runAcpProvider()` into the registration and add `installation` beside it. Run version and
update probes with the launch's arguments before your session subcommand, such as `hoplite
--version` for a provider that runs `hoplite acp`.

Paseo treats versions as text. It shows `version` and `versions` as written and never parses
them, so your check decides what counts as newer. Ask the source your CLI's own updater asks, and
leave `checkForUpdates` out when you cannot. A check that returns `unknown`, throws, or misses its
deadline shows **Couldn't check for updates** with your message and never shows **Up to date**.

`update` runs only when a user selects **Update**, and Paseo runs one update per provider at a
time. Pass the updater's output to `report` unchanged; Paseo keeps the last 65,536 characters. Paseo adds no
verification of its own, so the update does what your command does in a terminal. Return
`succeeded` with a message that says when the new version takes effect, or `failed` with the reason.
A failed update shows until the user refreshes the provider. Without `update`, **Update instructions** opens `updateUrl` instead.

**Update** and **Update instructions** appear whenever `inspect` reports the CLI installed. The
check only says what it knows beside them, so declare `update` even when you cannot check.

Paseo calls `inspect` when the settings open and keeps the answer for 30 seconds. It keeps a
`current` or `available` answer from `checkForUpdates` for an hour while `inspect` reports the same
version, so a CLI updated outside Paseo is checked again once the inspection expires. `inspect` must answer within 20 seconds and `checkForUpdates` within 25.
`update` has no deadline. `signal` aborts when Paseo stops waiting or the daemon stops.
See the [`installation` reference](/docs/plugins/reference#provider-installation) for every field.

## Help users fix problems

A user who gets a wrong result opens the provider's settings before they ask for help. Give that
page what they need: declare `docsUrl`, and return the facts that explain a wrong result from
`status`.

```ts
export function createProvider(): ProviderRegistration {
  return {
    id: "example-agent",
    label: "Example Agent",
    command: ["example-agent"],
    docsUrl: "https://example.com/docs/paseo#troubleshooting",
    async status({ launch }) {
      if (!launch) return { available: false, diagnostic: "example-agent has no command" };
      return { available: true, diagnostic: `Profile: ${launch.env.EXAMPLE_PROFILE ?? "default"}` };
    },
    async connect(request) {
      // ...
    },
  };
}
```

**Docs** opens `docsUrl`. **Diagnostic report** shows the command, the path of the executable and
the version that Paseo found, then your `Profile` row. Report what the CLI reads from its
environment, such as the account, the profile, or the configuration file in use. Those differ
between the daemon and the user's terminal, and the user cannot see them from the app.
See the [troubleshooting reference](/docs/plugins/reference#provider-troubleshooting) for the rows
that Paseo writes and for the rules of `status`.

## Adapt an ACP agent

Use the ACP shim when the agent already speaks ACP:

```ts
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(
    runAcpProvider({
      id: "vendor-agent",
      label: "Vendor agent",
      icon: "icon.svg",
      command: ["vendor-agent", "acp"],
    }),
  );
  return () => {};
}
```

The shim owns the ACP process, capability mapping, session lifecycle, prompts, permissions, and
timeline conversion. Do not copy that machinery into the plugin.

Use `transformers` for vendor differences ACP cannot describe. The
[goose model transformer](https://github.com/getpaseo/paseo/blob/main/plugins/goose-provider/server/models.ts)
uses `context.request` to read the agent's model inventory and `config` to prefix session model IDs
with the active provider. See the [ACP adapter reference](/docs/plugins/reference#providers).

Validate vendor payloads with
Zod and leave malformed or unrelated values unchanged:

```ts
import type { AcpTransformer } from "@getpaseo/plugin/server/acp";
import { z } from "zod";

const editSchema = z.object({
  path: z.string(),
  before: z.string(),
  after: z.string(),
});

export const vendorEdits: AcpTransformer = {
  toolCall(toolCall) {
    if (toolCall.name !== "vendor_file_edit") return toolCall;
    const input = editSchema.safeParse(toolCall.input);
    if (!input.success) return toolCall;
    return {
      ...toolCall,
      kind: "edit",
      input: {
        filePath: input.data.path,
        oldString: input.data.before,
        newString: input.data.after,
      },
    };
  },
};
```

Paseo builds a standard tool card from each call's ACP `kind`: Shell for `execute`, Read for `read`,
Edit for `edit` and `delete`, Search for `search`, and Fetch for `fetch`. The card reads the call's
`input` (ACP `rawInput`), `output` (`rawOutput`), `content`, and `locations`. A call of another kind
shows its raw input and output, or its text content when the agent sends neither.

Set `detail` on the returned tool call to replace the standard card. For example, an agent can
report a new file as an ACP edit, while the plugin returns a `write` detail with the file path and
contents. Return `{ type: "unknown", input, output }` to show the raw values.

`toolCall` runs on every update of a call, with the updates merged so far. An update that sends
`content` replaces the earlier content, as ACP defines. When an agent sends a value only in an
early update, read it from `context.previous`, the call as Paseo last presented it. The
[Hermes terminal transformer](https://github.com/getpaseo/paseo/blob/main/plugins/hermes-provider/server/terminal-command.ts)
keeps the command from Hermes's first update this way.

Use `sessionOpen` when an ACP agent needs extension metadata on `session/new` or `session/load`.
The hook receives the system prompt and the agent capabilities' `_meta` from `initialize`.
Return `metadata` to add fields to the session request's `_meta`.
If your plugin previously saved a different persistence format, return its native `sessionId`.
Paseo gives its own saved session ID precedence and writes the ACP persistence format after opening.

A `configure` transformer can inspect the agent's current choices with `catalog()` and pass a
translated change to `apply(change)`. Applying a change this way uses the shared ACP configuration
mapping and skips the transformers for that change.

Set `acpOptions.loadReplayQuietPeriodMs` for an agent that streams history after its `session/load`
response. Paseo publishes the session as ready once that interval passes without a history update.
Non-history state and metadata updates (such as commands, configuration, mode, usage, and session
info) do not extend the wait.

Set `acpOptions.autoAcceptMode` to offer an unattended mode backed by a specific native mode.
The adapter selects an unambiguous ACP `allow_once` action without opening a Paseo approval.
Set `default: true` to make this the default for new sessions. The adapter requires an idle
session without pending approvals before it switches to or from this mode.

Set `acpOptions.perModelThinkingOptions` for an agent that lists `thought_level` choices only for
the selected model. Catalog discovery selects each model in turn and gives it the thinking options
the agent lists for it. A model without a `thought_level` option gets no thinking picker.

## Test and publish

Test the provider against the real agent, not only mocked frames:

1. install the plugin as a directory source;
2. confirm its SVG, models, modes, and option controls appear;
3. create a session and complete a real prompt;
4. exercise permissions, steering, cancellation, persistence, and replay when supported;
5. render every custom timeline item on desktop and mobile-width layouts;
6. reload and remove the plugin while a session is active and confirm the session terminates.

Follow [Publish a plugin](/docs/plugins/publishing) to distribute the provider through npm or Git.
Keep agent compatibility and releases in the plugin project.

See the [plugin reference](/docs/plugins/reference#providers) for the exact runtime and SVG
rules.
