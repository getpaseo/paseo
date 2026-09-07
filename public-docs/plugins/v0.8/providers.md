---
title: Build a provider plugin
description: Add a coding agent to Paseo directly or adapt an ACP agent.
nav: Provider plugins
order: 47
category: Plugins
---

# Build a provider plugin

> **For the upcoming Paseo v0.8 release.** Start with the
> [plugin quickstart](/docs/plugins/v0.8) if you have not built a Paseo plugin before.

A provider plugin connects a coding agent to Paseo without adding it to Paseo core. Publish the
plugin in a Git repository and users can install and update it with `paseo plugin add` and
`paseo plugin update`.

Choose one implementation path:

| Agent                                                             | Path                                                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| It already implements ACP                                         | Register it with `runAcpProvider()` and add only narrow vendor transformers. |
| It has a TypeScript SDK, JSON-RPC API, or custom process protocol | Implement `ProviderRegistration` directly.                                   |

The complete examples are:

- [`provider-direct`](https://github.com/getpaseo/paseo/tree/main/plugin-examples/provider-direct): sessions, settings, prompts, persistence, child sessions, and a provider-owned timeline renderer;
- [`provider-acp-transformer`](https://github.com/getpaseo/paseo/tree/main/plugin-examples/provider-acp-transformer): an ACP command with a Zod-validated vendor edit transformer;
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

## Open a session

`session.open` contains the complete launch configuration: working directory, environment, system
prompt, MCP servers, tool policy, model, mode, settings, opaque provider options, and persistence
preference.

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
    settings: [],
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

## Add session-specific composer controls

Add `session.configure` only when the native agent has settings users should change after opening a
session. Publish them in `session.config` as toggle or select controls:

```ts
emit({
  type: "session.config",
  sessionId,
  config: {
    model: "agent-large",
    models: [{ id: "agent-large", label: "Agent Large" }],
    modes: [],
    thinkingOptions: [],
    settings: [
      {
        type: "toggle",
        id: "fast",
        label: "Fast mode",
        value: nativeSession.fast,
      },
      {
        type: "select",
        id: "approval",
        label: "Approvals",
        value: nativeSession.approval,
        options: [
          { label: "Ask", value: "ask" },
          { label: "Auto accept", value: "auto" },
        ],
      },
    ],
  },
});
```

Paseo renders these controls in the composer. A user change arrives as `session.configure`; apply it
and publish the committed `session.config` before `request.completed`. The provider may change the
available controls at runtime, including after a model change.

`settings` are user-facing controls. `providerOptions` is opaque JSON supplied at session creation
for provider-specific configuration that Paseo does not render. A provider-specific token budget
belongs in one of those two places; it is not a dedicated prompt field.

## Add persistence and replay

Advertise `session.persistence` when a native session can be reopened. Open a new native session
when `session.open.persistence` is absent. Resume the identified native session when it is present.
Return an opaque persistence value in `session.opened` or `session.persistence`; Paseo stores it
without inspecting it.

When `history` is `"replay"`, publish the native session's existing `timeline.item` snapshots before
`session.ready`. Use `history: "skip"` to open without replaying old rows.

Paseo refreshes an agent by closing its current provider session and opening it again with current
configuration and persistence. Re-read credentials, environment, global configuration, and MCP
servers during `session.open`. There is no separate reload operation.

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

Use `transformers` only for vendor differences ACP cannot describe. Validate vendor payloads with
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

## Test and publish

Test the provider against the real agent, not only mocked frames:

1. install the plugin as a directory source;
2. confirm its SVG, models, modes, and settings appear;
3. create a session and complete a real prompt;
4. exercise permissions, steering, cancellation, persistence, and replay when supported;
5. render every custom timeline item on desktop and mobile-width layouts;
6. reload and remove the plugin while a session is active and confirm the session terminates.

Push the plugin to a Git repository. Users install it with:

```bash
paseo plugin add owner/repository
paseo plugin update my-provider-plugin
```

Keep vendor compatibility and releases in that repository. Paseo core should only change when the
provider boundary cannot express a user-facing capability shared by more than one provider.

See the [plugin reference](/docs/plugins/v0.8/reference#providers) for the exact runtime and SVG
rules.
