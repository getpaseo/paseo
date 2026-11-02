---
title: TypeScript SDK
description: 在 TypeScript 程序中运行 Paseo 编程 Agent。
nav: 概览
---

# TypeScript SDK {#typescript-sdk}

`@getpaseo/client` 是一个 TypeScript 库，让你在自己的程序中驱动 Paseo daemon。你选择 Provider 和模型，给 Agent 一段提示词和一个目录，然后等待回答。

工作由 daemon 完成：它启动 Provider 的 CLI，保持会话存活，并把会话流式传输到 Paseo 应用。你的程序是一个客户端。你创建的 Agent 会和你手动启动的 Agent 一起出现在 Paseo 中，并且在你的程序退出后仍然保留。

可以用它来：

- 把 issue、告警或 webhook 变成编程任务；
- 并行运行多个 Agent 并收集它们的回答；
- 保持会话打开并发送后续提示词；
- 为你的 Agent 构建一个仪表盘。

## 启动 daemon {#start-a-daemon}

```bash
npx @getpaseo/cli
```

它监听 `ws://127.0.0.1:6767/ws`。

## 运行 Agent {#run-an-agent}

```ts
import { createPaseoClient } from "@getpaseo/client";

const client = createPaseoClient({ url: "ws://127.0.0.1:6767/ws" });
await client.connect();

const agent = await client.agents.create({
  config: { provider: "codex/gpt-5.5" },
  cwd: "/Users/me/dev/storefront",
  prompt: "Review the current diff and name the riskiest change.",
});

const result = await agent.waitForFinish();
console.log(result.lastMessage);

await client.close();
```

[快速开始](/docs/sdk/quickstart)逐行讲解了这段代码，并介绍了密码和远程 daemon。
