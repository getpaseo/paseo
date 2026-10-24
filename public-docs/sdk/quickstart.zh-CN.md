---
title: SDK 快速开始
description: 连接 Paseo daemon，运行一个编程 Agent，并读取它的回复。
nav: 快速开始
---

# SDK 快速开始 {#sdk-quickstart}

```bash
npm install @getpaseo/client
```

需要 Node.js 22 或更高版本。

## 连接 {#connect}

```ts
import { createPaseoClient } from "@getpaseo/client";

const client = createPaseoClient({ url: "ws://127.0.0.1:6767/ws" });
await client.connect();
```

daemon 表明身份后，`connect()` 就会 resolve。如果 daemon 设置了密码，请传入密码：

```ts
const client = createPaseoClient({
  url: "wss://devbox.example.com/ws",
  password: "my-secret",
});
```

## 创建 Agent {#create-an-agent}

```ts
const agent = await client.agents.create({
  config: { provider: "codex/gpt-5.5" },
  cwd: "/Users/me/dev/storefront",
  prompt: "Review the current diff and name the riskiest change.",
});
```

`config.provider` 的格式始终是 `provider/model`。[Provider](/docs/sdk/providers) 列出了 daemon 可用的 Provider，以及如何在运行时发现它们。

`cwd` 是 Agent 工作的目录。Paseo 会在它背后创建工作区。如何复用已有工作区，见[工作区](/docs/sdk/workspaces)。

会话一建立，`create()` 就会 resolve，此时提示词仍在运行。

## 等待回复 {#wait-for-the-reply}

```ts
const result = await agent.waitForFinish();

if (result.status === "idle") {
  console.log(result.lastMessage);
}
```

`waitForFinish()` 默认最多等待 10 分钟；传入毫秒数可以修改。它返回以下四种状态之一：

| 状态         | 含义                                     |
| ------------ | ---------------------------------------- |
| `idle`       | 本轮已结束，Agent 可以接收下一条提示词。 |
| `permission` | Agent 需要有人在 Paseo 中回应权限请求。  |
| `error`      | Provider 以错误结束了本轮。              |
| `timeout`    | 已超过截止时间。Agent 仍在运行。         |

## 断开连接 {#disconnect}

```ts
await client.close();
```

Agent 会继续在 daemon 上运行，并在 Paseo 中保持可见。之后的程序可以通过 ID 再次访问它：

```ts
const agent = client.agents.ref("agent_01H8X...");
await agent.refresh();
await agent.run("Now write the fix.");
```

## 接下来 {#next}

- [Agent](/docs/sdk/agents)：后续提示词、查找已有 Agent、归档。
- [Provider](/docs/sdk/providers)：从 daemon 发现模型和模式。
- [Provider 选项](/docs/sdk/provider-options)：沙箱和 Provider 原生设置。
- [工作区](/docs/sdk/workspaces)：复用工作区或创建 worktree。
- [事件](/docs/sdk/events)：以流式方式接收更新，而不是等待。
