---
title: 插件钩子
description: 为 Agent 和工作区操作注册钩子，修改请求或接收通知。
nav: 钩子
---

# 插件钩子 {#plugin-hooks}

在 `index.server.ts` 中使用 `server.addHook(name, handler)`。钩子在插件启用时运行，即使没有连接的应用。`addHook` 从 Paseo 0.14 起可用；将 `requirements.paseo` 设置为你开发插件时使用的版本。

```ts
import type { PluginServerContext } from "@getpaseo/plugin/server";

export default function contribute(server: PluginServerContext) {
  const remove = server.addHook("agent.open.before", async ({ request }) => ({
    ...request,
    env: { ...request.env, REGION: "eu" },
  }));
  return remove;
}
```

## 命名与等待 {#naming-and-timing}

名称遵循 `subject.operation.position`：主体、操作、`before` 或 `after`。名称标识生命周期中的位置；Paseo 是否等待由每个钩子决定，见下表。`workspace` 包括所有工作区，`worktree` 仅包括 git worktree。

- 等待型钩子结束后 Paseo 才继续。抛出错误、返回无效数据或超过 30 秒会让操作失败，错误包含 `Plugin <id> <hook> failed: …`。修改请求的钩子收到 `{ request }`，可以返回完整的替换请求或 `undefined`。
- 通知收到事件对象，返回 `Promise<void>`。Paseo 不等待；错误会记录在插件名下，原操作继续。`agent.turn.before` 和 `agent.permission.before` 分别在轮次开始或权限进入待处理状态时发出通知。

所有处理函数都必须为异步函数。轮次完成包括成功、失败和取消，请查看 `outcome`。权限完成包括所有处理结果，请查看 `resolution`。

创建 Agent 会发生一次，`agent.create.before` 修改已保存的配置。打开 Agent 指启动 Provider 进程，包括首次运行、daemon 重启后恢复、读取历史、导入外部会话和重新加载。`agent.open.before` 为每次启动提供临时的环境变量、工具和 MCP 服务器。创建会打开 Agent；打开已有 Agent 不会创建它；关闭会结束运行中的实例。在应用中打开标签页不属于此操作。

`worktree.create.after` 在工作区注册前运行，随后是 `workspace.create.after`，两者都早于第一个 Agent 的 `agent.create.before` / `agent.open.before`。

### 从等待型钩子提前返回 {#return-early-from-a-waiting-hook}

如果操作应立即继续，可以启动独立任务并返回：

```ts
server.addHook("worktree.create.after", async ({ worktree }) => {
  void warmCaches(worktree.path);
});
```

Paseo 只观察返回的 Promise，因此独立任务没有错误报告，也没有取消 `signal`。

## 钩子一览 {#hooks}

| 钩子                      | 等待 | 载荷                                   | 可修改                                    |
| ------------------------- | ---- | -------------------------------------- | ----------------------------------------- |
| `workspace.create.before` | 是   | `{ request }`                          | 整个创建请求                              |
| `workspace.create.after`  | 否   | `{ workspace }`                        |                                           |
| `workspace.archive.after` | 否   | `{ workspace }`                        |                                           |
| `worktree.create.before`  | 是   | `{ request }`                          | 创建选项和目标路径                        |
| `worktree.create.after`   | 是   | `{ worktree }`                         | worktree 中的文件；抛出错误中止创建       |
| `agent.create.before`     | 是   | `{ request: { config, env? } }`        | 除 `cwd` 外的已保存配置；`env`            |
| `agent.create.after`      | 否   | `{ agent }`                            |                                           |
| `agent.open.before`       | 是   | `{ request }`                          | 仅用于启动的 `env`、`tools`、`mcpServers` |
| `agent.close.after`       | 否   | `{ agent }`                            |                                           |
| `agent.archive.after`     | 否   | `{ agent, archivedAt }`                |                                           |
| `agent.turn.before`       | 否   | `{ agent, turnId }`                    |                                           |
| `agent.turn.after`        | 否   | `{ agent, turnId, outcome, timeline }` |                                           |
| `agent.permission.before` | 否   | `{ agent, request }`                   |                                           |
| `agent.permission.after`  | 否   | `{ agent, requestId, resolution }`     |                                           |

## 共享载荷 {#shared-payloads}

```ts
interface PluginHookAgent {
  id: string;
  workspaceId: string | null;
  parentAgentId: string | null;
  provider: string;
  cwd: string;
  title: string | null;
}

interface PluginHookWorkspace {
  id: string;
  projectId: string;
  cwd: string;
  name: string | null;
  archivedAt: string | null;
}

type PluginTurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string; code?: string } }
  | { kind: "canceled"; reason: string };
```

| 字段         | 结构 / 含义                                                                              |
| ------------ | ---------------------------------------------------------------------------------------- |
| `turnId`     | Provider 报告的 `string` 或 `null`；会话重新打开后可能重复                               |
| `timeline`   | 已弃用，始终为 `[]`；通过 SDK 获取历史。                                                 |
| `request`    | SDK 的 `AgentPermissionRequest`；`kind` 为 `tool`、`plan`、`question`、`mode` 或 `other` |
| `resolution` | SDK 的 `AgentPermissionResponse`                                                         |
| `archivedAt` | 时间戳字符串                                                                             |

## workspace.create.before {#workspacecreatebefore}

收到 `{ request }`，其中包含 `source`、可选的 `title` 和 `firstAgentContext`。可替换整个显式创建请求；抛出错误、无效返回或超时会让创建失败。已有工作区和目录查找、导入不受影响。

### 选择工作区隔离方式 {#choose-workspace-isolation}

```ts
server.addHook("workspace.create.before", async ({ request }) => {
  if (request.source.kind !== "directory") {
    return request;
  }

  return {
    ...request,
    source: {
      kind: "worktree",
      cwd: request.source.path,
      action: "branch-off",
    },
  };
});
```

**结果**：显式的目录创建请求会变成 worktree 请求。已有的工作区以及目录查找/导入操作不受影响。

## workspace.create.after {#workspacecreateafter}

工作区记录创建且目录可用后触发，收到 `{ workspace }`。

```ts
server.addHook("workspace.create.after", async ({ workspace }) => {
  console.log(workspace);
});
```

## workspace.archive.after {#workspacearchiveafter}

归档状态保存后触发，收到 `{ workspace }`；worktree 清理可能尚未完成。

```ts
server.addHook("workspace.archive.after", async ({ workspace }) => {
  console.log(workspace);
});
```

## worktree.create.before {#worktreecreatebefore}

为新 worktree 选择路径和创建选项。通过应用、CLI、MCP 或创建 Agent 新建 worktree 时，Paseo 在 `git worktree add` 之前等待此钩子。钩子收到 `{ request }`，返回完整的替换请求，或返回 `undefined` 保持原值。抛出错误、返回无效数据或超过 30 秒会终止创建，错误包含插件和钩子名称。

```ts
import { basename, dirname, join } from "node:path";

server.addHook("worktree.create.before", async ({ request }) => ({
  ...request,
  path: join(
    dirname(request.sourceCheckout),
    `${basename(request.sourceCheckout)}.${request.branch.replaceAll("/", "-")}`,
  ),
}));
```

源检出目录为 `/home/me/src/paseo`、分支为 `feature/x` 时，目标为 `/home/me/src/paseo.feature-x`。完整插件见 [worktree-placement 示例](https://github.com/getpaseo/paseo/tree/main/plugin-examples/worktree-placement)。

| 请求字段                                  | 含义                                                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `kind`                                    | `branch-off`、`checkout-branch`、`checkout-change-request` 或 `checkout-github-pr`                                     |
| `branch`                                  | 请求的本地分支名称                                                                                                     |
| `baseRef`                                 | branch-off 的起始引用；变更请求的比较基准；`checkout-branch` 不含此字段。要从引用创建分支，返回 `kind: "branch-off"`。 |
| `slug`                                    | 规范化的 worktree 名称                                                                                                 |
| `path`                                    | 绝对目标路径，初始值为已处理现有路径后缀的默认位置                                                                     |
| `repoRoot`                                | 只读，主仓库根目录                                                                                                     |
| `sourceCheckout`                          | 只读，源检出根目录，也支持从另一个 worktree 发起创建                                                                   |
| `forge`、`changeRequestNumber`、`headRef` | 变更请求检出标识；旧版 GitHub 检出用 `githubPrNumber` 代替 `forge` 和 `changeRequestNumber`                            |
| `headRepositoryOwner`、`headRepository`   | 可选的源仓库信息；`headRepository` 仅用于变更请求检出                                                                  |
| `checkoutRefs`                            | 可选的获取源：`{ remoteName?: string, remoteRef: string }[]`                                                           |
| `pushRemoteUrl`、`trackOriginHead`        | 可选的推送目标和跟踪策略                                                                                               |

返回 `path` 后，`slug` 仅用于 branch-off 分支命名；CLI 使用路径的最后一级目录名查找 worktree。

除 `repoRoot` 和 `sourceCheckout` 外，所有字段都可以修改。返回所选 `kind` 的全部必填字段。Paseo 在钩子之后解析 Git 源计划，因此钩子可以在获取引用之前修改分支和基准，而 Git 之后仍可能选择唯一的最终分支名称。

Paseo 解析父目录中的符号链接并验证返回的路径。路径必须为绝对路径且不存在，不能是文件系统根目录、用户主目录、仓库根目录、`.git` 目录内的路径或仓库的祖先目录。目标已存在时创建失败，Paseo 不会为插件选择的路径添加后缀。插件应让 Paseo 创建目录。

顺序：`worktree.create.before` → `git worktree add` → `worktree.create.after` → 注册工作区。恢复缺失的 worktree 时使用记录的原路径，不运行这两个创建钩子。

## worktree.create.after {#worktreecreateafter}

新的 git worktree 在磁盘上创建后，Paseo 会等待此钩子，然后才注册工作区、运行 setup、打开终端或启动 Agent。收到 `{ worktree: { path, branch, sourceCheckout } }`，分别是 worktree 绝对路径、分支名、来源 checkout 目录。此时还没有工作区 id。无需返回数据，直接写入 worktree 即可。抛出错误或超过 30 秒会中止创建并删除新 worktree。

此钩子覆盖新建分支、检出分支和检出 PR。恢复缺失的已归档 worktree 使用独立路径，不触发此钩子。

```ts
import { copyFile } from "node:fs/promises";

server.addHook("worktree.create.after", async ({ worktree }) => {
  await copyFile(`${worktree.sourceCheckout}/.env`, `${worktree.path}/.env`);
});
```

## agent.create.before {#agentcreatebefore}

收到 `{ request: { config, env? } }`。配置修改会保存，即使插件以后被停用或移除；`env` 只用于首次启动，不会保存。不能修改 `config.cwd`。抛出错误、无效返回或超时会让创建失败。

**`agent.create.before.config`** 使用 `AgentSessionConfig`：

| 字段                                          | 约束                                                     |
| --------------------------------------------- | -------------------------------------------------------- |
| `provider`, `model`                           | 独立的字段；修改 Provider 可能需要同时修改模型/模式/选项 |
| `modeId`, `thinkingOptionId`, `featureValues` | 特定于 Provider 的选择                                   |
| `title`, `systemPrompt`                       | Agent 配置                                               |
| `providerOptions`                             | 不透明的、特定于 Provider 的选项                         |
| `mcpServers`, `toolPolicy`                    | MCP 配置和精确的工具预批准                               |
| `cwd`                                         | 不能修改                                                 |

### 修改已保存的配置 {#change-saved-configuration}

在 `contribute(server)` 中添加这个回调，为新的 Codex Agent 设置已保存的选项：

```ts
server.addHook("agent.create.before", async ({ request }) => {
  if (request.config.provider !== "codex") {
    return request;
  }

  return {
    ...request,
    config: {
      ...request.config,
      providerOptions: {
        ...request.config.providerOptions,
        sandbox_mode: "workspace-write",
        approval_policy: "on-request",
      },
    },
  };
});
```

| 输入                                        | 结果                |
| ------------------------------------------- | ------------------- |
| `providerOptions.sandbox_mode: "read-only"` | `"workspace-write"` |
| `providerOptions.web_search: "disabled"`    | 由展开运算保留      |

所选的 Provider 会校验 `providerOptions`。显式的 Codex 沙盒和批准选项会覆盖它的模式预设。

## agent.create.after {#agentcreateafter}

常规创建完成后触发，收到 `{ agent }`；导入和恢复不会触发。

```ts
server.addHook("agent.create.after", async ({ agent }) => {
  console.log(agent);
});
```

## agent.open.before {#agentopenbefore}

收到 `{ request }`，只能修改 `env`、`tools` 和 `mcpServers`，修改只用于此次启动。其他字段只读。抛出错误、无效返回或超时会让打开操作失败。

**`agent.open.before` 请求示例：**

```json
{
  "agentId": "agent-123",
  "workspaceId": "workspace-456",
  "provider": "codex",
  "cwd": "/projects/shop",
  "title": "Workspace notes",
  "labels": { "notes/enabled": "true" },
  "tools": [],
  "mcpServers": {},
  "reason": "resume",
  "purpose": "interactive",
  "env": { "COMPANY_ENV": "development" }
}
```

| 字段          | 取值                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| `workspaceId` | 字符串或 `null`                                                                                          |
| `title`       | 只读字符串或 `null`；创建时使用创建请求的标题，恢复时使用已保存的标题。                                  |
| `labels`      | 只读的字符串映射；创建时使用创建请求的标签，恢复时使用已保存的标签。                                     |
| `tools`       | 可编辑的 `AgentToolDefinition[]`，仅包含此插件的工具。参阅[为 Agent 附加工具](#attach-tools-to-agents)。 |
| `mcpServers`  | 可编辑的服务器映射，仅用于启动且仅包含本插件的条目。参阅[注入 MCP 服务器](#inject-mcp-servers)。         |
| `reason`      | `create`、`resume`、`refresh`、`import`                                                                  |
| `purpose`     | `interactive`、`history`                                                                                 |
| `env`         | 启动覆盖映射；不包括 daemon 继承的环境变量。替换整个映射即可添加、替换或移除覆盖项。                     |

### 在每次打开会话时注入环境变量 {#inject-environment-variables-on-every-session-opening}

```ts
server.addHook("agent.open.before", async ({ request }) => {
  return {
    ...request,
    env: {
      ...request.env,
      COMPANY_ENV: "development",
    },
  };
});
```

会话打开时的环境变量覆盖项会在每次打开时重新计算。`agent.create.before.env` 只作用于首次启动，不会写入 Agent 的已保存配置。

### 注入 MCP 服务器 {#inject-mcp-servers}

需要将服务器保存为 Agent 配置的一部分时，使用 `agent.create.before.config.mcpServers`。
插件拥有的服务器使用下面的回调，在 `contribute(server)` 中添加，并把占位 URL 替换为你的 MCP 端点：

```ts
server.addHook("agent.open.before", async ({ request }) => {
  if (request.provider !== "codex") return;

  return {
    ...request,
    mcpServers: {
      ...request.mcpServers,
      company: { type: "http", url: "https://tools.example.com/mcp" },
    },
  };
});
```

`request.mcpServers` 使用与 `AgentSessionConfig.mcpServers` 相同的服务器配置。
每个插件的映射从空开始，只在该插件自己的回调之间累积，不包含 Agent 已保存的服务器或其他插件的服务器。
替换映射即可添加、替换或移除本插件的条目；返回 `undefined` 会保持不变。
Paseo 按插件 ID 顺序合并各插件的最终映射。

名称与已保存的服务器、Paseo 内部的 `paseo` 服务器或其他插件的服务器冲突时，会话打开失败，错误会指出服务器名称及双方来源。
不支持 MCP 的 Provider 会报 `does not support MCP servers` 错误，并指出插件名称。
`purpose: "history"` 的会话打开会忽略这些服务器。安装、停用和重新加载插件后，现有 Agent
通过[会话重新打开行为](#attach-tools-to-agents)获取变化。

### 为 Agent 附加工具 {#attach-tools-to-agents}

在 `index.server.ts` 中定义工具，并在 `server.addHook("agent.open.before", async handler)` 中附加它。
此示例只向带有 `notes/enabled: "true"` 标签的 Agent 提供 `append_workspace_note`：

```ts
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineAgentTool, type PluginServerContext } from "@getpaseo/plugin/server";

const appendWorkspaceNote = defineAgentTool({
  name: "append_workspace_note",
  description: "Append a note to AGENT_NOTES.md in this agent's working directory.",
  input: z.object({ note: z.string().min(1).describe("Note to append") }),
  async execute({ note }, { agent, signal }) {
    const notePath = path.join(agent.cwd, "AGENT_NOTES.md");
    await writeFile(notePath, `${note}\n`, { encoding: "utf8", flag: "a", signal });
    return {
      text: `Saved note to ${notePath}`,
      structuredContent: { path: notePath },
    };
  },
});

export default function contribute(server: PluginServerContext) {
  server.addHook("agent.open.before", async ({ request }) => {
    if (request.labels["notes/enabled"] !== "true") return;
    return { ...request, tools: [...request.tools, appendWorkspaceNote] };
  });
  return () => {};
}
```

通过 SDK 创建 Agent 时设置标签：

```ts
const agent = await paseo.agents.create({
  config: { provider: "codex/gpt-5.4" },
  cwd: "/projects/shop",
  labels: { "notes/enabled": "true" },
});
```

使用会话打开请求中的字段选择 Agent：

| 选择依据   | 回调中的条件                                 |
| ---------- | -------------------------------------------- |
| 标签       | `request.labels["notes/enabled"] === "true"` |
| Provider   | `request.provider === "codex"`               |
| 工作区     | `request.workspaceId === "workspace-456"`    |
| 单个 Agent | `request.agentId === chosenAgentId`          |

每个插件的 `request.tools` 都从空数组开始。同一插件中的后续回调会看到前面回调返回的工具；
替换数组即可添加或移除工具。返回 `undefined` 会保留请求。`purpose: "history"` 时会忽略工具。

从 `@getpaseo/plugin/server` 导入 `defineAgentTool`、`AgentToolDefinition`、`AgentToolContext`
和 `AgentToolResult`。辅助函数会根据 Zod schema 推断验证后的输入类型：

```ts
declare function defineAgentTool<Input extends z.ZodType>(tool: {
  name: string;
  title?: string;
  description: string;
  input: Input;
  execute(
    input: z.output<Input>,
    context: AgentToolContext,
  ): AgentToolResult | Promise<AgentToolResult>;
}): AgentToolDefinition;

interface AgentToolResult {
  text?: string;
  structuredContent?: unknown;
  isError?: boolean;
}
```

| 执行 context | 值                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------- |
| `agent`      | 发起调用的 Agent，以 `PluginHookAgent` 表示，包括 `id`、`workspaceId`、`provider`、`cwd` 和 `title` |
| `paseo`      | 已连接到此 daemon 的 SDK                                                                            |
| `signal`     | 此次工具调用的中止信号；请把它传给文件操作或外部请求                                                |

`execute` 在插件进程中运行。闭包和原始 Zod schema 保留在该进程中；只有工具元数据和调用的
输入、结果会跨进程传递。Paseo 在调用 `execute` 前验证输入。无效输入会将 schema 问题返回给
Agent。抛出的错误会转换为 `{ isError: true, text: message }`，插件继续运行。取消调用或关闭
其传输连接会中止 `signal` 并丢弃结果。工具调用最长运行 10 分钟，与钩子的 30 秒超时分开。
关闭或重新打开 Agent 会话会移除旧定义。

在 `text` 中返回模型可见的文本。`structuredContent` 必须可序列化为 JSON；省略 `text` 时，
Paseo 会将该值格式化为供模型读取的文本。设置 `isError: true` 可报告工具错误。

Paseo 通过 Agent 工具传输提供附加的工具，按 Provider 的支持情况使用 MCP 或原生注册。
同一份定义和回调适用于这两种方式。附加的工具遵循[与 Paseo 工具相同的限制](/docs/mcp#limit-paseo-tools-by-provider)。
只有该 Agent 能看到这些工具。

名称必须匹配 `/^[a-z][a-z0-9_]*$/`，且不超过 64 个字符。如果名称与同一 Agent 的 Paseo
工具或另一插件的工具冲突，会话打开会失败，并指出双方。一个插件内的重复名称也会导致
会话打开失败。回调未选中的 Agent 不受影响。

| 变更                                                  | Agent 何时收到变更                                                                                                                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 启动、停止或重新加载声明了 `agent.open.before` 的插件 | 已打开的会话会标记为过期。每个会话在下一次空闲提示词前重新打开；正在运行的轮次会继续，不会被中断。重新打开后的下一条提示词复用该会话。                                             |
| 修改回调选择的 Agent                                  | 编辑此示例后运行 `paseo plugin reload agent-tools`，然后在 Agent 空闲时发送提示词。                                                                                                |
| 立即应用                                              | 调用 `await paseo.agents.ref(id).reload({ requestId: "reload-notes" })`。`requestId` 可选。这会重新打开 Provider 会话，以 `reason: "refresh"` 再次运行钩子，并中断正在运行的轮次。 |
| 读取当前快照                                          | 调用 `await paseo.agents.ref(id).refresh()`。这只读取状态，不会重新打开会话。                                                                                                      |

如果自动重新打开失败，触发它的提示词会返回该错误。参阅
[完整 agent-tools 示例](https://github.com/getpaseo/paseo/tree/main/plugin-examples/agent-tools)。

## agent.close.after {#agentcloseafter}

运行中的 Agent 实例关闭后触发，收到 `{ agent }`。

```ts
server.addHook("agent.close.after", async ({ agent }) => {
  console.log(agent);
});
```

## agent.archive.after {#agentarchiveafter}

归档状态保存后触发，收到 `{ agent, archivedAt }`；运行时清理可能尚未完成。

```ts
server.addHook("agent.archive.after", async ({ agent, archivedAt }) => {
  console.log(agent, archivedAt);
});
```

## agent.turn.before {#agentturnbefore}

实时轮次开始后触发，收到 `{ agent, turnId }`。历史重放不会触发。

```ts
server.addHook("agent.turn.before", async ({ agent, turnId }) => {
  console.log(agent, turnId);
});
```

## agent.turn.after {#agentturnafter}

实时轮次完成、失败或取消后触发，收到 `{ agent, turnId, outcome, timeline }`。`outcome.kind` 为 `completed`、`failed` 或 `canceled`。`timeline` 已弃用且始终为空；请按下面的示例通过 SDK 获取历史。

### 在轮次结束时发送后续消息 {#send-a-follow-up-when-a-turn-ends}

把 [server/inspect.ts](https://github.com/getpaseo/paseo/blob/main/plugin-examples/lifecycle-actions/server/inspect.ts) 复制到你的插件中。该辅助文件从 `@getpaseo/protocol/agent-types` 导入类型；请把与 daemon 版本相同的 `@getpaseo/protocol` 加入开发依赖，并在加载插件之前安装它们。`latestOutputText` 会拼接最近一条用户消息之后的文本片段。

```ts
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { latestOutputText } from "./server/inspect";

export default function contribute(server: PluginServerContext) {
  server.addHook("agent.turn.after", async (event, context) => {
    if (event.outcome.kind === "canceled") {
      return;
    }

    const agent = context.paseo.agents.ref(event.agent.id);
    const page = await agent.timeline.refetch({ direction: "tail", limit: 20 });
    const text = latestOutputText(page.entries.map(({ item }) => item));
    if (/out of credits/i.test(text)) {
      await agent.send("Try again.");
    }
  });

  return () => {};
}
```

```text
Turn ends: "out of credits"
  → plugin sends "Try again."
  → a new turn starts
```

该处理函数只获取最近 20 条时间线条目，不检查这一页之前的输出。插件需要更多历史时，请用 `cursor` 和 `direction` 继续翻页。

这会用现有的 SDK 发送一条新消息。持续匹配会不断发送后续消息；需要时请在插件中添加次数限制或延迟。附件和工具的效果不会被重放。

## agent.permission.before {#agentpermissionbefore}

权限或问题进入待处理状态后触发，收到 `{ agent, request }`；`request` 为 `AgentPermissionRequest`。通过 SDK 回应。

### 回应权限请求 {#answer-a-permission-request}

使用同一个[辅助文件](https://github.com/getpaseo/paseo/blob/main/plugin-examples/lifecycle-actions/server/inspect.ts)中的 `shellCommand`：

```ts
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { shellCommand } from "./server/inspect";

export default function contribute(server: PluginServerContext) {
  server.addHook("agent.permission.before", async (event, context) => {
    const command = shellCommand(event.request);
    if (command === null) {
      return;
    }

    const agent = context.paseo.agents.ref(event.agent.id);
    if (/\brm\s+-rf\b/.test(command)) {
      await agent.respondToPermission({
        requestId: event.request.id,
        response: { behavior: "deny", message: "Recursive deletion is blocked." },
      });
      return;
    }

    if (command.trim() === "git status") {
      await agent.respondToPermission({
        requestId: event.request.id,
        response: { behavior: "allow" },
      });
    }
  });

  return () => {};
}
```

| 请求             | 结果                 |
| ---------------- | -------------------- |
| `rm -rf build`   | 拒绝                 |
| `git status`     | 批准                 |
| 其他命令或请求   | 保持待处理，留给用户 |
| 已经处理过的请求 | SDK 响应失败         |

这个正则表达式只是一个示例策略，而不是 shell 解析器。权限请求也可能是问题、计划和模式变更；请求权限不会结束当前轮次。

## agent.permission.after {#agentpermissionafter}

待处理请求得到回应或清除后触发，收到 `{ agent, requestId, resolution }`；`resolution` 为 `AgentPermissionResponse`。

```ts
server.addHook("agent.permission.after", async ({ agent, requestId, resolution }) => {
  console.log(agent, requestId, resolution);
});
```

Agent 钩子不包括 daemon 的私有临时辅助 Agent。公开的后台工作区及其普通 Agent 使用相同钩子。

## 顺序与返回值 {#ordering-and-returned-values}

```text
Creation request
  → agent.create.before hooks (plugin-ID order; registration order within each plugin)
  → resolve defaults and validate provider configuration
  → derive launch configuration with Paseo runtime tools and daemon prompt
  → agent.open.before hooks (same ordering; env and plugin-local tools and MCP servers)
  → set PASEO_AGENT_ID and PASEO_AGENT_CWD
  → open provider session and save agent configuration
```

| 回调返回                                                | 下一个回调收到                    |
| ------------------------------------------------------- | --------------------------------- |
| `{ ...request, env: { ...request.env, REGION: "eu" } }` | 之前的请求，添加或替换了 `REGION` |
| `{ ...request, env: { REGION: "eu" } }`                 | 之前的请求，整个覆盖映射被替换    |
| `undefined`                                             | 未改变的请求                      |
| 抛出错误或返回无效数据                                  | 操作失败；后面的回调不会运行      |

没有自动的深度合并。`env` 在插件之间累积；`tools` 和 `mcpServers` 只在同一插件的回调之间累积。
返回替换的映射或数组会替换该范围内之前的值。

## context 与清理 {#context-and-cleanup}

| 契约                       | 行为                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `context.paseo`            | 已连接到此 daemon 的现有 SDK                                                       |
| `context.signal`           | 在调用超时或插件停止时中止；请把它传给外部请求                                     |
| 输入数据                   | 分离的快照；通过返回的请求或 SDK 命令改变状态                                      |
| 注册结果                   | 幂等的移除函数，例如 `const remove = server.addHook(...); remove();`               |
| 重新加载、停用、移除、关闭 | 移除剩余的注册                                                                     |
| 未知的钩子名称             | 注册失败                                                                           |
| 钩子超时                   | 30 秒；会中止 signal。等待型钩子会让待处理的操作失败；事件处理函数会记录一条错误。 |
| 事件处理函数出错           | 记录在插件名下；原操作继续进行                                                     |
| 事件投递                   | 实时、尽力而为；没有重放、持久化或自动重试                                         |
| 事件并发                   | 不同的事件可能重叠；不保证回调完成的顺序                                           |

## 完整示例 {#complete-examples}

| 插件                                                                                                   | 包含                                                      |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| [lifecycle-logger](https://github.com/getpaseo/paseo/tree/main/plugin-examples/lifecycle-logger)       | Agent、工作区和 worktree 钩子；隐去环境变量值的 JSON 日志 |
| [lifecycle-actions](https://github.com/getpaseo/paseo/tree/main/plugin-examples/lifecycle-actions)     | 后续消息、权限、环境变量、切换 Provider、选择 worktree    |
| [agent-configuration](https://github.com/getpaseo/paseo/tree/main/plugin-examples/agent-configuration) | MCP 注入以及 Codex 沙盒/批准选项                          |
| [agent-tools](https://github.com/getpaseo/paseo/tree/main/plugin-examples/agent-tools)                 | 按标签选择 Agent，并在插件进程中执行文件操作的工具        |

用 `paseo plugin logs lifecycle-logger` 或主机的 `daemon.log` 读取 logger 的输出。

## 已重命名的钩子 {#renamed-hooks}

旧注册方法已弃用，会在 2027-04-30 之后移除。现有插件继续按原来的方式运行。同一插件中混合使用新旧注册方法时，处理函数按注册顺序运行。`addHook` 只接受新名称。

| 旧注册方式                                         | 新注册方式                                                |
| -------------------------------------------------- | --------------------------------------------------------- |
| `server.before("workspace.create", handler)`       | `server.addHook("workspace.create.before", asyncHandler)` |
| `server.on("workspace.created", handler)`          | `server.addHook("workspace.create.after", asyncHandler)`  |
| `server.on("workspace.archived", handler)`         | `server.addHook("workspace.archive.after", asyncHandler)` |
| `server.before("agent.create", handler)`           | `server.addHook("agent.create.before", asyncHandler)`     |
| `server.on("agent.created", handler)`              | `server.addHook("agent.create.after", asyncHandler)`      |
| `server.before("agent.session_open", handler)`     | `server.addHook("agent.open.before", asyncHandler)`       |
| `server.on("agent.closed", handler)`               | `server.addHook("agent.close.after", asyncHandler)`       |
| `server.on("agent.archived", handler)`             | `server.addHook("agent.archive.after", asyncHandler)`     |
| `server.on("agent.turn_started", handler)`         | `server.addHook("agent.turn.before", asyncHandler)`       |
| `server.on("agent.turn_ended", handler)`           | `server.addHook("agent.turn.after", asyncHandler)`        |
| `server.on("agent.permission_requested", handler)` | `server.addHook("agent.permission.before", asyncHandler)` |
| `server.on("agent.permission_resolved", handler)`  | `server.addHook("agent.permission.after", asyncHandler)`  |
