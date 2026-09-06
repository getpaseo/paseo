---
title: Workspaces with the SDK
description: Open directories as Paseo workspaces, place agents in them, follow changes, and archive them.
nav: Workspaces
order: 53
category: TypeScript SDK
---

# Workspaces with the SDK

Use a workspace when an integration needs a durable place in the Paseo app for agents, terminals, browsers, and files related to one task.

## Open a directory

```ts
const workspace = await client.workspaces.open("/Users/me/dev/storefront");

console.log(workspace.id);
console.log(workspace.directory);
```

`open()` creates the project when needed and reuses the active workspace for that exact directory. Use it when the directory is the identity you care about.

## Create a fresh workspace

`create()` always creates a new workspace, even when another workspace already uses the directory:

```ts
const workspace = await client.workspaces.create({
  source: {
    kind: "directory",
    path: "/Users/me/dev/storefront",
  },
  title: "Checkout issue 42",
});
```

Create a Paseo-owned worktree when concurrent work needs an isolated checkout:

```ts
const workspace = await client.workspaces.create({
  source: {
    kind: "worktree",
    cwd: "/Users/me/dev/storefront",
    action: "branch-off",
    refName: "main",
    branchName: "fix/checkout-42",
  },
  title: "Checkout issue 42",
});
```

You can pass `projectId` in either source when you already have one. Most integrations should omit it; the daemon finds or creates the project from the directory.

## Start an agent in a workspace

Create through the workspace handle:

```ts
const agent = await workspace.agents.create({
  config: {
    provider: "claude/claude-sonnet-5",
  },
  prompt: "Map the checkout flow before changing anything.",
});
```

The handle supplies both the workspace identity and its actual directory. This avoids mismatched placement arguments.

For a one-off agent, you can skip the workspace call:

```ts
const agent = await client.agents.create({
  config: {
    provider: "claude/claude-sonnet-5",
  },
  cwd: "/Users/me/dev/storefront",
  prompt: "Map the checkout flow before changing anything.",
});
```

The daemon still creates a project and a fresh workspace. Read `agent.workspaceId` when you need the generated workspace ID.

## Start a terminal in a workspace

```ts
const terminal = await workspace.terminals.create({ name: "Development" });
terminal.write("echo ready");
terminal.sendKeys(["Enter"]);

const { lines } = await terminal.capture();
const { entries } = await workspace.terminals.list();
await terminal.kill();
```

Two workspaces may share a directory. The workspace handle supplies the ID that keeps their terminals separate. To use an ID you already have, call `client.workspaces.ref(workspaceId).terminals.create()`.

See the [terminal API reference](/docs/sdk/reference#clientterminals) for command arguments, working-directory overrides, input, and capture options.

## List workspaces

```ts
let cursor: string | undefined;

do {
  const page = await client.workspaces.list({
    filter: { query: "storefront" },
    page: { limit: 50, cursor },
  });

  for (const workspace of page.entries) {
    console.log(workspace.id, workspace.name, workspace.status);
  }

  cursor = page.pageInfo.nextCursor ?? undefined;
} while (cursor);
```

## Refresh and archive a handle

```ts
const workspace = client.workspaces.ref(savedWorkspaceId);
const snapshot = await workspace.refresh();

if (snapshot) {
  await workspace.archive();
}
```

Workspace archive is separate from agent archive. Archive each resource according to the lifecycle your integration owns.
