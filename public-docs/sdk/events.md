---
title: SDK events
description: Subscribe to agent status, timeline, workspace, and provider updates without maintaining a second state model.
nav: Events
order: 56
category: TypeScript SDK
---

# SDK events

Use an owned subscription to fetch a snapshot and follow its changes. Connecting, plain reads, and local listeners do not start observation. Each observation gets a new server-issued ID, even when its filter matches another observation.

## Follow one agent's status

```ts
const directory = await client.agents.list({
  filter: { includeArchived: false },
  subscribe: {},
});

directory.subscription.subscribe({
  snapshot({ entries }) {
    const entry = entries.find(({ agent }) => agent.id === agentId);
    console.log(entry?.agent.status);
  },
  update(message) {
    if (message.type !== "agent_update") return;
    const update = message.payload;
    if (update.kind === "upsert" && update.agent.id === agentId) {
      console.log(update.agent.status);
    } else if (update.kind === "remove" && update.agentId === agentId) {
      console.log("Agent removed from this directory");
    }
  },
});

// When this view closes:
await directory.subscription.release();
```

`list({ subscribe: {} })` returns the snapshot, `subscriptionId`, and `subscription`. Omitting `subscribe` returns only a snapshot. Do not supply a subscription ID. The subscription delivers its snapshot before updates and receives a new ID and snapshot after reconnect. Releasing it leaves other observations and the underlying agents intact.

`client.agents.subscribe()` and agent-handle `subscribe()` add local listeners to observations owned by that API instance. They do not request data. Use the returned subscription's callbacks when multiple filtered views need separate updates.

## Follow timeline events

```ts
const unsubscribe = agent.timeline.subscribe((update) => {
  const { event } = update;
  if (event.type === "snapshot") {
    // Replace your recent history view; these are complete projected entries,
    // not additional live message fragments.
    console.log("Reconnected", event.page.epoch, event.page.entries);
    return;
  }
  if (event.type === "error") {
    console.error("Timeline observation stopped:", event.error);
    return;
  }
  if (event.type === "replacement") {
    // Previously fetched history belongs to an old epoch. Fetch the page your UI needs.
    void agent.timeline.refetch().then((page) => console.log(page.entries));
    return;
  }
  if (event.type === "timeline" && event.item.type === "assistant_message") {
    process.stdout.write(event.item.text);
  }

  if (event.type === "turn_completed") {
    console.log("\nTurn completed");
  }
});
```

Await `unsubscribe.ready` before starting work whose events you need to observe. It acknowledges the initial live subscription; initial history is a separate [read](#fetch-timeline-history). Call `unsubscribe()` to release demand, or await `unsubscribe.release()` for teardown.

After reconnect, the same handle receives `{ agentId, subscriptionId, event: { type: "snapshot", reason: "reconnect", page } }` before subsequent updates. The host assigns a fresh subscription ID. `page` is the latest 100 projected history entries, with the same epoch, cursors and paging flags as `timeline.refetch()`. Replace your recent view with this page; do not concatenate it with earlier message fragments. If `hasOlder` is true, fetch older pages with `page.startCursor`. Compare epochs before retaining any previously loaded history: a reconnect may preserve or replace the epoch. A live `replacement` event still means the previous epoch is invalid.

Persisted history is recovered; transient events such as an offline turn-completion notification are not replayed. Recovery buffers at most 128 current-connection updates. Overflow or a concurrent replacement discards the obsolete buffer and reads a fresh page. A recovery read failure delivers `{ agentId, event: { type: "error", error } }` and releases that observation; establish a new subscription when ready to retry. Release suppresses pending recovery callbacks. Each same-agent subscription recovers independently.

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
  console.log(entry.seqStart, entry.seqEnd, entry.item.type);
}
```

Use `startCursor`, `endCursor`, `hasOlder`, and `hasNewer` from the result to page without inventing offsets.

## Follow workspace updates

```ts
const directory = await client.workspaces.list({ subscribe: {} });
directory.subscription.subscribe({
  snapshot({ entries }) {
    console.log(entries);
  },
  update(message) {
    if (message.type === "workspace_update") console.log(message.payload);
  },
});

// When this view closes:
await directory.subscription.release();
```

## Follow provider catalog changes

```ts
const observation = client.observeEvents(["providers_snapshot_update"]);
const unsubscribe = client.providers.subscribe((update) => {
  const ready = update.entries.filter((entry) => entry.status === "ready");
  console.log(
    "Ready providers:",
    ready.map((entry) => entry.provider),
  );
});
await observation.ready;
console.log(await client.providers.snapshot());

// When this view closes:
unsubscribe();
await observation.release();
```

Project listeners work the same way: request `client.observeEvents(["project.update"])` before relying on `client.projects.subscribe()`. For an initial project cache, buffer updates while awaiting `client.projects.list()`, then apply them after the snapshot.

Call `client.close()` when the application no longer needs the connection. Observation requires a host that advertises independent subscriptions; an older host returns an update-host error. Plain reads remain available.
