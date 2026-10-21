---
title: 在 SDK 中使用 Agent
description: 用 TypeScript 创建、运行、查找、复用、设置父级和归档编程 Agent。
nav: Agent
---

# 在 SDK 中使用 Agent {#agents-with-the-sdk}

Agent 句柄持有一个稳定的 Agent ID，并在不暴露 daemon RPC 的情况下提供每一轮的生命周期。

## 运行初始提示词 {#run-an-initial-prompt}

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

`waitForFinish()` 返回以下四种状态之一：

| 状态         | 含义                                     |
| ------------ | ---------------------------------------- |
| `idle`       | 本轮已完成，Agent 可以接收下一条提示词。 |
| `permission` | Agent 需要有人在 Paseo 中回应权限请求。  |
| `error`      | Provider 以错误结束了本轮。              |
| `timeout`    | 已超过等待截止时间；Agent 可能仍在运行。 |

超时不会取消 Agent。

## 为后续提示词保持会话 {#keep-a-session-alive-for-follow-ups}

当提示词稍后才会到来时，创建一个空闲的会话：

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

只管发送、不关心结果时使用 `send()`。调用方需要该轮的结果时使用 `run()`。

## 按标签查找 Agent {#find-agents-by-label}

创建时设置 `labels`，之后按标签过滤。匹配由 daemon 完成：

```ts
const page = await client.agents.list({
  filter: { labels: { "issue-provider": "my-tracker" } },
});

for (const { agent } of page.entries) {
  console.log(agent.id, agent.title, agent.status);
}
```

## 通过 ID 继续 Agent {#continue-an-agent-by-id}

```ts
const agent = client.agents.ref("agent_01H8X...");

const result = await agent.run("Now write the fix.");
console.log(result.lastMessage);
```

`ref()` 不会联系 daemon。当你需要知道 Agent 是否仍然存在时，先调用 `refresh()`；如果不存在，它返回 `null`。

## 创建子 Agent {#create-a-subagent}

通过工作区创建子 Agent。句柄负责位置，因此调用方无需重复提供目录：

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

`parent` 建立父子关系。归档父 Agent 会级联归档它的子 Agent。如果子 Agent 应该独立继续，请先调用 `detach()`。

## 在后台工作区中运行工作 {#run-work-in-a-background-workspace}

在一次调用中创建一个后台工作区及其第一个 Agent。把 `background` 放在工作区选项中，把 Agent 的配置放在 `agent` 下：

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

该调用返回一个工作区句柄，并用提供的提示词启动它的第一个 Agent。

后台 Agent 会保留历史记录，并在 daemon 重启后继续存在。默认的发现结果会隐藏它们；使用 `client.agents.list({ filter: { includeBackground: true } })` 可以包含它们。精确 ID 的句柄可以正常使用。默认值和调用方继承规则见[创建工作区](./workspaces.md#create-a-fresh-workspace)。

## 请求结构化输出 {#request-structured-output}

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

在把解析出的值作为可信输入使用之前，请在你的应用中校验它。

## 读取 Agent 的当前状态 {#read-the-current-state-of-an-agent}

```ts
const agent = client.agents.ref("agent_01H8X...");
await agent.refresh();

if (agent.pendingPermissions?.length) {
  console.log(`Waiting on ${agent.pendingPermissions.length} permission request(s)`);
}
console.log(agent.lastUsage?.totalCostUsd, agent.runtimeInfo?.sessionId);
```

句柄以属性的形式提供 `status`、`capabilities`、`availableModes`、`pendingPermissions`、`activeTurn`、`lastUsage`、`lastError`、`features`、`runtimeInfo`、`archivedAt`、`workspaceId` 和 `cwd`。它们读取的都是句柄最近观察到的快照，从不发起请求。

`ref()` 返回的句柄还没有观察到任何内容，因此在 `refresh()`、`run()`、`waitForFinish()`、时间线重新获取或 `subscribe()` 投递快照之前，这些属性都是 `null`。已观察到的快照中的可选值也读作 `null`。当你需要整个快照，或需要区分这些状态时，请使用 `current()`。

`subscribe()` 是一个本地监听器。它的更新来自一个由你持有的 Agent 目录观察：

```ts
const unsubscribe = agent.subscribe(() => {
  if (agent.status === "error") console.error(agent.lastError);
});
const directory = await client.agents.list({ subscribe: {} });

// When this view closes:
unsubscribe();
await directory.subscription.release();
```

## 列出会话加载的命令 {#list-the-commands-a-session-loaded}

```ts
const { commands, error } = await agent.commands();
if (error) throw new Error(error);

const skills = commands.filter((command) => command.kind === "skill");
```

结果来自正在运行的会话，而不是目录扫描，因此它包含 Provider 内置的、从不出现在磁盘上的命令和技能。`kind` 是 Provider 自己的分类，且是可选的；缺少 `kind` 时应视为未分类，而不是假定为 `"command"`。

无法生成列表的 Provider 会在 `error` 中报告，并返回空的 `commands` 数组。该调用不会 reject。

## 归档或解除父子关系 {#archive-or-detach}

```ts
await agent.archive(); // Soft-deletes the agent and closes its runtime.
await child.detach(); // Keeps the child alive but removes its parent relationship.
```

关闭 SDK 连接不会归档 Agent。请显式归档临时 Agent，最好放在 `finally` 中。
