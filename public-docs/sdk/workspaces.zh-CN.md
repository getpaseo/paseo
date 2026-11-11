---
title: 在 SDK 中使用工作区
description: 把目录打开为 Paseo 工作区，在其中放置 Agent，跟踪改动并归档。
nav: 工作区
---

# 在 SDK 中使用工作区 {#workspaces-with-the-sdk}

当集成需要在 Paseo 应用中为某个任务相关的 Agent、终端、浏览器和文件提供一个持久的位置时，请使用工作区。

## 打开目录 {#open-a-directory}

```ts
const workspace = await client.workspaces.open("/Users/me/dev/storefront");

console.log(workspace.id);
console.log(workspace.directory);
```

`open()` 会在需要时创建项目，并复用该目录对应的当前工作区。当目录本身就是你关心的身份标识时使用它。

## 创建新的工作区 {#create-a-fresh-workspace}

`create()` 总是创建新的工作区，即使已有其他工作区在使用该目录：

```ts
const workspace = await client.workspaces.create({
  source: {
    kind: "directory",
    path: "/Users/me/dev/storefront",
  },
  title: "Checkout issue 42",
});
```

当并行工作需要隔离的检出时，创建一个由 Paseo 管理的 worktree：

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

传入 `agent` 可以在一次调用中同时创建工作区及其第一个 Agent。参见[后台工作区组合示例](./agents.md#run-work-in-a-background-workspace)。可见性在工作区选项中设置；`agent.background` 会被拒绝。

如果你已经有 `projectId`，可以在任一种来源中传入它。大多数集成应该省略它；daemon 会根据目录查找或创建项目。

传入 `background: true` 可以让工作区不出现在默认的发现结果中。它的 Agent 和终端仍然是持久的，有正常的历史记录、生命周期钩子、归档和精确 ID 访问。应用侧边栏提供 **显示后台工作区**，不会丢弃已同步的状态。

`background` 只能在创建时设置。省略时默认为 false；当 `callerAgentId` 指明是某个 Agent 在创建新工作区时，省略则继承该 Agent 所在工作区的值。显式的 false 或 true 会覆盖继承。带 `workspaceId` 创建 Agent 时会拒绝显式的后台创建意图；请在创建工作区时配置可见性。SDK/RPC 的隐式 Agent 创建也接受 `background`，但它表示工作区的创建意图，而不是 Agent 的属性。

创建和包含后台工作区的发现都需要 `features.backgroundWorkspaces`；对于不支持的主机，客户端会拒绝并提示更新主机。

## 在工作区中启动 Agent {#start-an-agent-in-a-workspace}

通过工作区句柄创建：

```ts
const agent = await workspace.agents.create({
  config: {
    provider: "claude/claude-sonnet-5",
  },
  prompt: "Map the checkout flow before changing anything.",
});
```

句柄同时提供工作区身份和它的实际目录，避免位置参数不匹配。

对于一次性的 Agent，可以跳过工作区调用：

```ts
const agent = await client.agents.create({
  config: {
    provider: "claude/claude-sonnet-5",
  },
  cwd: "/Users/me/dev/storefront",
  prompt: "Map the checkout flow before changing anything.",
});
```

daemon 仍然会创建一个项目和一个新的工作区。需要生成的工作区 ID 时，读取 `agent.workspaceId`。

## 在工作区中启动终端 {#start-a-terminal-in-a-workspace}

```ts
const terminal = await workspace.terminals.create({ name: "Development" });
terminal.write("echo ready");
terminal.sendKeys(["Enter"]);

const { lines } = await terminal.capture();
const { entries } = await workspace.terminals.list();
await terminal.kill();
```

两个工作区可以共享同一个目录。工作区句柄提供的 ID 让它们的终端相互独立。要使用你已有的 ID，请调用 `client.workspaces.ref(workspaceId).terminals.create()`。

命令参数、工作目录覆盖、输入和捕获选项见[终端 API 参考](/docs/sdk/reference#clientterminals)。

## 列出工作区 {#list-workspaces}

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

除非 `filter.includeBackground` 为 true，否则后台工作区不会被列出。使用 `client.workspaces.list({ filter: { includeBackground: true } })` 或 `client.agents.list({ filter: { includeBackground: true } })`。工作区描述符带有 `background`；Agent 的可见性来自它所在的工作区，没有单独的设置。

## 刷新和归档句柄 {#refresh-and-archive-a-handle}

```ts
const workspace = client.workspaces.ref(savedWorkspaceId);
const snapshot = await workspace.refresh();

if (snapshot) {
  await workspace.archive();
}
```

工作区归档与 Agent 归档是分开的。请按照你的集成所负责的生命周期分别归档每个资源。
