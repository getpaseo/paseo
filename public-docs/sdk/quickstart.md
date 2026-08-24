---
title: SDK quickstart
description: Connect to a Paseo daemon, run one coding agent, and read its reply.
nav: Quickstart
order: 51
category: TypeScript SDK
---

# SDK quickstart

```bash
npm install @getpaseo/client
```

Requires Node.js 22 or newer.

## Connect

```ts
import { createPaseoClient } from "@getpaseo/client";

const client = createPaseoClient({ url: "ws://127.0.0.1:6767/ws" });
await client.connect();
```

`connect()` resolves once the daemon has identified itself. If the daemon has a password, pass it:

```ts
const client = createPaseoClient({
  url: "wss://devbox.example.com/ws",
  password: "my-secret",
});
```

## Create an agent

```ts
const agent = await client.agents.create({
  config: { provider: "codex/gpt-5.5" },
  cwd: "/Users/me/dev/storefront",
  prompt: "Review the current diff and name the riskiest change.",
});
```

`config.provider` is always `provider/model`. [Providers](/docs/sdk/providers) lists what the daemon has available and how to discover it at runtime.

`cwd` is the directory the agent works in. Paseo creates the workspace behind it. [Workspaces](/docs/sdk/workspaces) covers reusing one instead.

`create()` resolves as soon as the session exists. The prompt is still running.

## Wait for the reply

```ts
const result = await agent.waitForFinish();

if (result.status === "idle") {
  console.log(result.lastMessage);
}
```

`waitForFinish()` waits up to 10 minutes by default; pass milliseconds to change it. It returns one of four statuses:

| Status       | Meaning                                                           |
| ------------ | ----------------------------------------------------------------- |
| `idle`       | The turn finished and the agent can take another prompt.          |
| `permission` | The agent needs a person to answer a permission request in Paseo. |
| `error`      | The provider ended the turn with an error.                        |
| `timeout`    | The deadline elapsed. The agent is still running.                 |

## Disconnect

```ts
await client.close();
```

The agent keeps running on the daemon and stays visible in Paseo. A later program reaches it again by ID:

```ts
const agent = client.agents.ref("agent_01H8X...");
await agent.refresh();
await agent.run("Now write the fix.");
```

## Next

- [Agents](/docs/sdk/agents), follow-up prompts, finding existing agents, archiving.
- [Providers](/docs/sdk/providers), discovering models and modes from the daemon.
- [Provider options](/docs/sdk/provider-options), sandboxing and provider-native settings.
- [Workspaces](/docs/sdk/workspaces), reusing a workspace or creating a worktree.
- [Events](/docs/sdk/events), streaming updates instead of waiting.
