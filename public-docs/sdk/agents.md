---
title: Agents with the SDK
description: Create, run, find, reuse, parent, and archive coding agents from TypeScript.
nav: Agents
order: 52
category: TypeScript SDK
---

# Agents with the SDK

An agent handle keeps a stable agent ID and exposes the turn lifecycle without exposing daemon RPCs.

## Run an initial prompt

```ts
const agent = await client.agents.create({
  config: {
    provider: "claude/claude-sonnet-5",
  },
  cwd: "/Users/me/dev/storefront",
  prompt: "Review the checkout flow and propose one focused fix.",
  labels: { source: "checkout-review" },
});

const result = await agent.waitForFinish();
console.log(result.status, result.lastMessage);
```

`waitForFinish()` returns one of four statuses:

| Status       | Meaning                                                           |
| ------------ | ----------------------------------------------------------------- |
| `idle`       | The turn completed and the agent can accept another prompt.       |
| `permission` | The agent needs a person to answer a permission request in Paseo. |
| `error`      | The provider ended the turn with an error.                        |
| `timeout`    | The wait deadline elapsed; the agent may still be running.        |

A timeout does not cancel the agent.

## Keep a session alive for follow-ups

Create an idle session when prompts arrive later:

```ts
const reviewer = await client.agents.create({
  config: {
    provider: "codex/gpt-5.5",
  },
  cwd: "/Users/me/dev/storefront",
  title: "Checkout reviewer",
});

const first = await reviewer.run("Review the current diff.");

if (first.status === "idle") {
  const second = await reviewer.run("Now focus on failure recovery.");
  console.log(second.lastMessage);
}
```

Use `send()` for fire-and-forget delivery. Use `run()` when the caller needs the outcome of that turn.

## Find agents by label

Set `labels` at creation, then filter on them. The daemon does the matching:

```ts
const page = await client.agents.list({
  filter: { labels: { "issue-provider": "my-tracker" } },
});

for (const { agent } of page.entries) {
  console.log(agent.id, agent.title, agent.status);
}
```

## Continue an agent by ID

```ts
const agent = client.agents.ref("agent_01H8X...");

const result = await agent.run("Now write the fix.");
console.log(result.lastMessage);
```

`ref()` does not contact the daemon. Call `refresh()` first when you need to know whether the agent still exists; it returns `null` if it does not.

## Create a subagent

Create a child through its workspace. The handle owns placement, so the caller does not repeat its directory:

```ts
if (!parent.workspaceId) throw new Error("Parent has no workspace");

const workspace = client.workspaces.ref(parent.workspaceId);
const child = await workspace.agents.create({
  config: {
    provider: "codex/gpt-5.5",
  },
  parent,
  title: "Implement checkout fix",
  prompt: "Implement the accepted checkout plan and run focused tests.",
});
```

`parent` establishes parentage. Archiving a parent cascade-archives its children. Call `detach()` first when a child should continue independently.

## Request structured output

```ts
const schema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    risk: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["summary", "risk"],
  additionalProperties: false,
};

const agent = await client.agents.create({
  config: {
    provider: "codex/gpt-5.5",
  },
  cwd: "/Users/me/dev/storefront",
  outputSchema: schema,
  prompt: "Assess the release risk of the current diff.",
});

const result = await agent.waitForFinish();
if (result.status !== "idle" || !result.lastMessage) {
  throw new Error(result.error ?? "Agent returned no structured output");
}

const assessment = JSON.parse(result.lastMessage) as {
  summary: string;
  risk: "low" | "medium" | "high";
};
```

Validate the parsed value in your application before using it as trusted input.

## Read the current state of an agent

```ts
const agent = client.agents.ref("agent_01H8X...");
await agent.refresh();

if (agent.pendingPermissions?.length) {
  console.log(`Waiting on ${agent.pendingPermissions.length} permission request(s)`);
}
console.log(agent.lastUsage?.totalCostUsd, agent.runtimeInfo?.sessionId);
```

The handle exposes `status`, `capabilities`, `availableModes`, `pendingPermissions`, `activeTurn`, `lastUsage`, `lastError`, `features`, `runtimeInfo`, `archivedAt`, `workspaceId`, and `cwd` as properties. All of them read the last snapshot the handle observed and never fetch.

A handle from `ref()` has observed nothing, so every one of them is `null` until `refresh()`, `run()`, `waitForFinish()`, a timeline refetch, or `subscribe()` delivers a snapshot. Optional values in an observed snapshot also read as `null`. Use `current()` when you need the whole snapshot or need to distinguish those states.

`subscribe()` keeps the properties current, so a long-lived handle can poll them without another RPC:

```ts
const unsubscribe = agent.subscribe(() => {
  if (agent.status === "error") console.error(agent.lastError);
});
```

## List the commands a session loaded

```ts
const { commands, error } = await agent.commands();
if (error) throw new Error(error);

const skills = commands.filter((command) => command.kind === "skill");
```

The answer comes from the running session, not from a directory scan, so it includes commands and skills built into the provider that never appear on disk. `kind` is the provider's own classification and is optional; treat a missing `kind` as unclassified rather than assuming `"command"`.

A provider that cannot produce a list reports that in `error` and returns an empty `commands` array. The call does not reject.

## Archive or detach

```ts
await agent.archive(); // Soft-deletes the agent and closes its runtime.
await child.detach(); // Keeps the child alive but removes its parent relationship.
```

Closing the SDK connection does not archive agents. Archive temporary agents explicitly, preferably in `finally`.
