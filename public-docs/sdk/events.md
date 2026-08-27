---
title: SDK events
description: Subscribe to agent status, timeline, workspace, and provider updates without maintaining a second state model.
nav: Events
order: 56
category: TypeScript SDK
---

# SDK events

Subscriptions report changes after they happen. Fetch an initial snapshot first, then apply updates to it.

Every `subscribe()` method returns a local unsubscribe function. It removes your callback; it does not stop or archive the underlying resource.

## Follow one agent's status

The daemon sends agent-directory updates only after the connection opens an agent-list subscription:

```ts
await client.agents.list({
  filter: { includeArchived: false },
  subscribe: { subscriptionId: "issue-board-agents" },
});

const agent = client.agents.ref(agentId);
await agent.refresh();

const unsubscribe = agent.subscribe((update) => {
  if (update.kind === "upsert") {
    console.log(update.agent.status);
  } else {
    console.log("Agent removed from the active directory");
  }
});
```

The handle updates its properties and `current()` value before it calls your handler.

## Follow timeline events

```ts
const unsubscribe = agent.timeline.subscribe(({ event, timestamp }) => {
  if (event.type === "timeline" && event.item.type === "assistant_message") {
    process.stdout.write(event.item.text);
  }

  if (event.type === "turn_completed") {
    console.log(`\nCompleted at ${timestamp}`);
  }
});
```

Assistant messages can arrive in pieces. Concatenate their text when you need a complete message, or use `run()` and read `lastMessage` when you only need the final reply.

Turn completion comes from `turn_completed`, `turn_failed`, or `turn_canceled`. Do not infer turn completion from an `agent_update` transition to `idle`.

## Fetch timeline history

```ts
const page = await agent.timeline.refetch({
  direction: "before",
  limit: 100,
  projection: "projected",
});

for (const entry of page.entries) {
  console.log(entry.seq, entry.event.type);
}
```

Use `startCursor`, `endCursor`, `hasOlder`, and `hasNewer` from the result to page without inventing offsets.

## Follow workspace updates

Workspace updates also require a directory subscription:

```ts
await client.workspaces.list({
  subscribe: { subscriptionId: "issue-board-workspaces" },
});

const workspace = client.workspaces.ref(workspaceId);
const unsubscribe = workspace.subscribe((update) => {
  if (update.kind === "upsert") {
    console.log(update.workspace.status);
  }
});
```

## Follow provider catalog changes

```ts
const unsubscribe = client.providers.subscribe((update) => {
  const ready = update.entries.filter((entry) => entry.status === "ready");
  console.log(
    "Ready providers:",
    ready.map((entry) => entry.provider),
  );
});
```

Always call the returned unsubscribe functions before discarding the owning object. Call `client.close()` when the application no longer needs the daemon connection.
