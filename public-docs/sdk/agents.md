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

## Run work in a background workspace

Create a background workspace and its first agent in one call. Put `background` on the
workspace options and the agent's configuration under `agent`:

```ts
const cwd = "/Users/me/dev/storefront";
const workspace = await client.workspaces.create({
  source: { kind: "directory", path: cwd },
  background: true,
  agent: {
    cwd,
    config: { provider: "codex/gpt-5.5" },
    prompt: "Review the checkout flow.",
  },
});
```

The call returns a workspace handle and starts its first agent with the supplied prompt.

Background agents keep their history and survive daemon restarts. Default discovery hides them;
use `client.agents.list({ filter: { includeBackground: true } })` to include them.
Exact-ID handles work normally. See [workspace creation](./workspaces.md#create-a-fresh-workspace)
for defaults and caller inheritance.

## Run a helper as a background agent

Pass `background: true` to run a helper in a workspace the user may have open. A background agent
opens no tab, stays out of its parent's subagent track and the sidebar status, and raises no
notifications. Default lists leave it out.

```ts
const helper = await client.workspaces.ref(workspaceId).agents.create({
  config: { provider: "codex/gpt-5.5" },
  prompt: "Summarize the last turn in one line.",
  background: true,
});
const result = await helper.waitForFinish();
console.log(result.lastMessage);
await helper.archive();
```

An agent created under a background `parent` is background unless you pass `background: false`.
A parent on another host passes this on only as a handle; with a bare address, pass `background`.
Placing a background agent in an existing workspace or under a parent requires
`features.backgroundAgents`; on an older host the SDK throws "Update the host to use background
agents." before sending.

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

`subscribe()` is a local listener. An owned agent-directory observation supplies its updates:

```ts
const unsubscribe = agent.subscribe(() => {
  if (agent.status === "error") console.error(agent.lastError);
});
const directory = await client.agents.list({ subscribe: {} });

// When this view closes:
unsubscribe();
await directory.subscription.release();
```

## Read account usage for an agent

```ts
const { reports, usageRevision } = await agent.listUsageReports();
```

Reports describe the account quotas associated with the agent's current provider launch, not
tokens consumed by this agent alone. They retain the usage source, account label, report ID,
and availability state. When usage checking is enabled, a known agent without a live usage
session returns an empty list and a `null` revision without reopening the session. The call
never falls back to the host's default account. When the host's **Check usage** switch is off,
requests reject before discovery or vendor calls.

Observe `usageRevision` in agent snapshots. Clear cached reports when it changes, then query
again when it is non-null. Before displaying a response, compare its revision with the latest
snapshot and discard it if they differ. Reload and resume can change the revision while preserving
the agent ID and provider conversation ID. A request that spans a revision change rejects; request again for the
new snapshot. Discard pending responses after removing an agent or replacing its observation.

The revision identifies the provider launch and model, not an account or quota freshness.
It also changes on a same-account reload or a model switch. A change does not mean the account
changed. Ordinary reads use the daemon's five-minute report cache; reserve `forceRefresh`, which
bypasses that cache, for an explicit refresh rather than routine polling. It does not change
credentials or detect credential-file edits inside an unchanged provider launch.
Account-routing plugins must reopen the provider session to apply a different launch environment.
This method requires a host advertising `server_info.features.agentUsageRevision`; older hosts
reject with an update-host message.

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
