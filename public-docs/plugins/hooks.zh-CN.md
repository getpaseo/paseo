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

名称遵循 `subject.operation.position`：主体、操作、`before` 或 `after`。名称标识生命周期中的位置；Paseo 是否等待由每个钩子决定，见下表。`workspace` 包括所有工作区，`worktree` 仅包括 git worktree。`terminal` 包括 Paseo 在工作区中启动的所有终端，`command` 包括 worktree 的 setup 和 teardown 命令。

- 等待型钩子结束后 Paseo 才继续。抛出错误、返回无效数据或超过 30 秒会让操作失败，错误包含 `Plugin <id> <hook> failed: …`。修改请求的钩子收到 `{ request }`，可以返回完整的替换请求或 `undefined`。
- 通知收到事件对象，返回 `Promise<void>`。Paseo 不等待；错误会记录在插件名下，原操作继续。`agent.turn.before` 和 `agent.permission.before` 分别在轮次开始或权限进入待处理状态时发出通知。

所有处理函数都必须为异步函数。轮次完成包括成功、失败和取消，请查看 `outcome`。权限完成包括所有处理结果，请查看 `resolution`。

创建 Agent 会发生一次，`agent.create.before` 修改已保存的配置。打开 Agent 指启动 Provider 进程，包括首次运行、daemon 重启后恢复、读取历史、导入外部会话和重新加载。`agent.open.before` 为每次启动提供临时的环境变量、指令、工具、MCP 服务器和启动包装。创建会打开 Agent；打开已有 Agent 不会创建它；关闭会结束运行中的实例。在应用中打开标签页不属于此操作。

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

| 钩子                      | 等待 | 载荷                                                   | 可修改                                                                  |
| ------------------------- | ---- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| `workspace.create.before` | 是   | `{ request }`                                          | 整个创建请求                                                            |
| `workspace.create.after`  | 否   | `{ workspace }`                                        |                                                                         |
| `workspace.archive.after` | 否   | `{ workspace }`                                        |                                                                         |
| `worktree.create.before`  | 是   | `{ request }`                                          | 创建选项和目标路径                                                      |
| `worktree.create.after`   | 是   | `{ worktree }`                                         | worktree 中的文件；抛出错误中止创建                                     |
| `agent.create.before`     | 是   | `{ request: { config, env?, metadata, workspaceId } }` | 除 `cwd` 外的已保存配置；`env`；`metadata`                              |
| `agent.create.after`      | 否   | `{ agent }`                                            |                                                                         |
| `agent.open.before`       | 是   | `{ request }`                                          | 仅用于启动的 `env`、`appendSystemPrompt`、`tools`、`mcpServers`、`wrap` |
| `agent.close.after`       | 否   | `{ agent }`                                            |                                                                         |
| `agent.archive.after`     | 否   | `{ agent, archivedAt }`                                |                                                                         |
| `agent.turn.before`       | 否   | `{ agent, turnId }`                                    |                                                                         |
| `agent.turn.after`        | 否   | `{ agent, turnId, outcome }`                           |                                                                         |
| `agent.permission.before` | 否   | `{ agent, request }`                                   |                                                                         |
| `agent.permission.after`  | 否   | `{ agent, requestId, resolution }`                     |                                                                         |
| `terminal.create.before`  | 是   | `{ request }`                                          | `env`、`wrap`；抛出错误则拒绝                                           |
| `command.run.before`      | 是   | `{ request }`                                          | `env`、`wrap`；抛出错误则拒绝                                           |

## 共享载荷 {#shared-payloads}

```ts
interface PluginHookAgent {
  id: string;
  workspaceId: string | null;
  parentAgentId: string | null;
  provider: string;
  cwd: string;
  title: string | null;
  readonly background: boolean;
  metadata: Record<string, JsonValue>;
}

interface PluginHookWorkspace {
  id: string;
  projectId: string;
  cwd: string;
  name: string | null;
  archivedAt: string | null;
  metadata: Record<string, JsonValue>;
}

type PluginTurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string; code?: string } }
  | { kind: "canceled"; reason: string };
```

| 字段         | 结构 / 含义                                                                              |
| ------------ | ---------------------------------------------------------------------------------------- |
| `background` | [后台 Agent](#background-agents) 为 `true`                                               |
| `turnId`     | Provider 报告的 `string` 或 `null`；在会话恢复后仍保持唯一                               |
| `timeline`   | 已弃用，始终为 `[]`；通过 SDK 获取历史。                                                 |
| `request`    | SDK 的 `AgentPermissionRequest`；`kind` 为 `tool`、`plan`、`question`、`mode` 或 `other` |
| `resolution` | SDK 的 `AgentPermissionResponse`                                                         |
| `archivedAt` | 时间戳字符串                                                                             |

## 元数据 {#metadata}

Agent 和工作区带有 `metadata` 记录，用于保存插件数据。键是字符串，值可以是任意 JSON 值，Paseo 只保存、不读取任何键。给键加上插件 ID 前缀，避免不同插件冲突。标签仍是用于筛选和标记的字符串；结构化数据请用元数据。

可以在创建 Agent 或工作区时设置元数据，也可以之后修改。`null` 删除该键，其他值会替换该键的整个值：

```ts
const agent = await paseo.agents.create({
  config: { provider: "codex/gpt-5.5" },
  cwd: "/projects/shop",
  metadata: { "linear.issue": { id: "ENG-123" } },
});

agent.metadata; // { "linear.issue": { id: "ENG-123" } }
await agent.setMetadata({ "linear.issue": null });
await paseo.workspaces.ref(workspaceId).setMetadata({ "linear.issue": { id: "ENG-123" } });
```

元数据在 daemon 重启后仍然保留。所有钩子载荷都带有元数据：`workspace.create.before` 和 `agent.create.before` 收到调用方发送的元数据，`after` 钩子和 `agent.open.before` 收到已保存的元数据。主机版本过旧时，这些调用会抛出 “Update the host to use metadata.”。

## 启动包装 {#launch-wraps}

`agent.open.before`、`terminal.create.before` 和 `command.run.before` 可以返回 `wrap: [executable, ...args]`，即 `PluginLaunchWrap`。Paseo 随后以 `[...wrap, command, ...args]` 启动进程，例如在沙盒中运行：

```ts
import type { PluginLaunchWrap } from "@getpaseo/plugin/server";

const sandbox: PluginLaunchWrap = ["/usr/local/bin/sandbox-run", "--profile", "agent"];
```

- 可执行文件必须是 daemon 主机上的绝对路径。Paseo 不经过 shell 运行它；Windows 的 `.cmd` 和 `.bat` 启动器例外，它们通过 cmd.exe 运行。每个元素保持为一个参数。
- 第一个返回包装的钩子选定包装。后面的钩子，无论属于同一插件还是之后的插件，可以省略 `wrap` 或返回相同的值。返回不同的值会让操作失败。
- 包装不会被保存。每次启动都会重新询问钩子。
- 不支持 `wrap` 的旧主机会拒绝该字段，操作失败，而不是不加包装地运行。

下面各钩子的章节说明其包装覆盖的范围。

## workspace.create.before {#workspacecreatebefore}

收到 `{ request }`，其中包含 `source`、可选的 `title`、可选的 `metadata` 和 `firstAgentContext`。可替换整个显式创建请求；抛出错误、无效返回或超时会让创建失败。已有工作区和目录查找、导入不受影响。

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

顺序：`worktree.create.before` → worktree 管理器 `create`（或 `git worktree add`）→ `worktree.create.after` → 注册工作区。若要将 `git worktree add`、移除和恢复委托给 Worktrunk 等外部工具，请使用 `server.registerWorktreeManager()` 注册 [worktree 管理器](/docs/plugins/reference#worktree-managers)，而不是在 `worktree.create.before` 中创建目录。恢复缺失的 worktree 时使用记录的原路径，不运行创建钩子，并在对应管理器提供可选 `restore` 处理函数时委托给它。

## worktree.create.after {#worktreecreateafter}

新的 git worktree 在磁盘上创建后，Paseo 会等待此钩子，然后才注册工作区、运行 setup、打开终端或启动 Agent。收到 `{ worktree: { path, branch, sourceCheckout } }`，分别是 worktree 绝对路径、分支名、来源 checkout 目录。此时还没有工作区 id。无需返回数据，直接写入 worktree 即可。抛出错误或超过 30 秒会中止创建并删除新 worktree。

此钩子覆盖新建分支、检出分支和检出 PR。恢复缺失的已归档 worktree 使用独立路径，不触发此钩子。

```ts
import { copyFile } from "node:fs/promises";

server.addHook("worktree.create.after", async ({ worktree }) => {
  await copyFile(`${worktree.sourceCheckout}/.env`, `${worktree.path}/.env`);
});
```

## terminal.create.before {#terminalcreatebefore}

Paseo 在工作区中启动终端之前等待此钩子：

- 应用中的 **新建终端** 和终端配置，以及通过 CLI、SDK 和插件创建的终端
- Agent 通过 Paseo 工具打开的终端
- 运行 `paseo.json` 脚本、服务和 worktree 终端的终端

钩子收到 `{ request }`，返回替换请求，或返回 `undefined` 保持原值。只能修改 `env` 和 `wrap`。抛出错误会拒绝创建终端，请求方收到 `Plugin <id> terminal.create.before failed: …`。

```ts
server.addHook("terminal.create.before", async ({ request }) => {
  if (!sandboxed.has(request.workspaceId)) return;
  return { ...request, wrap: ["/usr/local/bin/sandbox-run", "--profile", "terminal"] };
});
```

| 请求字段          | 含义                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspaceId`     | 只读，终端所属的工作区                                                                                                                         |
| `cwd`             | 只读，终端的起始目录                                                                                                                           |
| `source`          | 只读。`agent`：Agent 的 Paseo 工具。`script`：`paseo.json` 脚本或服务。`worktree`：`paseo.json` worktree 终端。`client`：应用、CLI、SDK 或插件 |
| `name`            | 只读，标签页名称，没有时为 null                                                                                                                |
| `input`           | 只读。对于 `script` 和 `worktree`，是 shell 启动后 Paseo 输入的命令；其他情况为 null                                                           |
| `command`、`args` | 只读，要运行的程序及其参数。启动默认 shell 时 `command` 为 null                                                                                |
| `env`             | Paseo 添加到终端环境中的变量                                                                                                                   |
| `wrap`            | 可选的[启动包装](#launch-wraps)。Paseo 启动 `[...wrap, command, ...args]`；没有 `command` 时，把默认 shell 放在包装之后                        |

脚本、服务和 worktree 终端先启动默认 shell，再向其中输入命令，所以 shell 的包装也覆盖它们运行的命令。被包装的 shell 启动时没有 Paseo 的 shell 集成，所以被包装的 `paseo.json` 脚本不会报告其命令何时结束。daemon 重启后仍在运行的终端会被接管，不会重新创建，也不会再次触发此钩子。插件在此钩子中创建终端时，该终端同样会触发此钩子。

## command.run.before {#commandrunbefore}

Paseo 在运行每条 `paseo.json` worktree `setup` 和 `teardown` 命令之前等待此钩子。钩子收到 `{ request }`，返回替换请求，或返回 `undefined` 保持原值。只能修改 `env` 和 `wrap`。抛出错误会拒绝该命令：setup 停止并报告插件的错误，teardown 停止并保留 worktree 目录，与命令失败时相同。

```ts
server.addHook("command.run.before", async ({ request }) => ({
  ...request,
  wrap: ["/usr/local/bin/sandbox-run", "--profile", request.purpose],
}));
```

| 请求字段      | 含义                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `workspaceId` | 只读，所属工作区；按路径归档 worktree 且没有工作区记录时为 null                                                        |
| `cwd`         | 只读，命令的运行目录                                                                                                   |
| `purpose`     | 只读，`setup` 或 `teardown`                                                                                            |
| `command`     | 只读，`paseo.json` 中写的命令：在 macOS 和 Linux 上用 `bash -c` 运行，在 Windows 上用 PowerShell 或 `cmd.exe` 运行     |
| `env`         | Paseo 在 daemon 环境之上添加的变量：`PASEO_SOURCE_CHECKOUT_PATH`、`PASEO_WORKTREE_PATH`、`PASEO_BRANCH_NAME` 等        |
| `wrap`        | 可选的[启动包装](#launch-wraps)。Paseo 在包装之后启动 shell：在 macOS 和 Linux 上是 `[...wrap, "bash", "-c", command]` |

setup 在工作区注册并发出 `workspace.create.after` 之后开始，与第一个 Agent 同时运行。setup 再次运行时，例如在 setup 被阻止的 worktree 上点击 **运行设置**，每条命令都会再次触发此钩子。teardown 在 worktree 上最后一个工作区归档时运行，在 Paseo 删除目录之前。

## agent.create.before {#agentcreatebefore}

收到 `{ request: { config, env?, metadata, workspaceId } }`。配置和 `metadata` 的修改会保存，即使插件以后被停用或移除；`env` 只用于首次启动，不会保存。不能修改 `config.cwd` 和 `workspaceId`。抛出错误、无效返回或超时会让创建失败。

`workspaceId` 是创建 Agent 的工作区，没有时为 null。请用它而不是 `config.cwd` 来确定工作区：多个工作区可以共用一个目录，Agent 也可能在一个工作区中创建，而目录位于另一个工作区内。

**`agent.create.before.config`** 使用 `AgentSessionConfig`：

| 字段                         | 约束                                                     |
| ---------------------------- | -------------------------------------------------------- |
| `provider`, `model`          | 独立的字段；修改 Provider 可能需要同时修改模型/模式/选项 |
| `modeId`, `thinkingOptionId` | 特定于 Provider 的选择                                   |
| `title`, `systemPrompt`      | Agent 配置                                               |
| `providerOptions`            | Provider 选项，包括速度和自动批准的选择                  |
| `mcpServers`, `toolPolicy`   | MCP 配置和精确的工具预批准                               |
| `cwd`                        | 不能修改                                                 |

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

收到 `{ request }`，只能修改 `env`、`appendSystemPrompt`、`tools`、`mcpServers` 和 `wrap`，修改只用于此次启动。其他字段只读。抛出错误、无效返回或超时会让打开操作失败。

不要 await 对正在打开的 Agent 的写入，例如 `setMetadata`。该写入要等打开完成，而打开在等你的钩子，结果钩子超时，打开失败。启动写入但不要 await，它会在打开完成后立即执行：

```ts
server.addHook("agent.open.before", async ({ request }, { paseo }) => {
  void paseo.agents
    .ref(request.agentId)
    .setMetadata({ "my.plugin": { openedBy: "hook" } })
    .catch((error) => console.error(error));
});
```

**`agent.open.before` 请求示例：**

```json
{
  "agentId": "agent-123",
  "workspaceId": "workspace-456",
  "provider": "codex",
  "cwd": "/projects/shop",
  "title": "Workspace notes",
  "background": false,
  "labels": { "notes/enabled": "true" },
  "metadata": { "linear.issue": { "id": "ENG-123" } },
  "tools": [],
  "mcpServers": {},
  "reason": "resume",
  "purpose": "interactive",
  "env": { "COMPANY_ENV": "development" }
}
```

| 字段          | 取值                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `workspaceId` | 字符串或 `null`                                                                                                            |
| `title`       | 只读字符串或 `null`；创建时使用创建请求的标题，恢复时使用已保存的标题。                                                    |
| `background`  | 只读；[后台 Agent](#background-agents) 为 `true`。在创建时确定。                                                           |
| `labels`      | 只读的字符串映射；创建时使用创建请求的标签，恢复时使用已保存的标签。                                                       |
| `metadata`    | 只读的 JSON 映射；Agent 上已保存的[元数据](#metadata)。                                                                    |
| `tools`       | 可编辑的 `AgentToolDefinition[]`，仅包含此插件的工具。参阅[为 Agent 附加工具](#attach-tools-to-agents)。                   |
| `mcpServers`  | 可编辑的服务器映射，仅用于启动且仅包含本插件的条目。参阅[注入 MCP 服务器](#inject-mcp-servers)。                           |
| `reason`      | `create`、`resume`、`refresh`、`import`                                                                                    |
| `purpose`     | `interactive`、`history`                                                                                                   |
| `env`         | 启动覆盖映射；不包括 daemon 继承的环境变量。替换整个映射即可添加、替换或移除覆盖项。                                       |
| `wrap`        | 可选的[启动包装](#launch-wraps)，用它启动 harness。参阅[通过启动包装运行 harness](#run-the-harness-behind-a-launch-wrap)。 |

### 通过启动包装运行 harness {#run-the-harness-behind-a-launch-wrap}

返回[启动包装](#launch-wraps)，让 Provider 的 harness 以 `[...wrap, command, ...args]` 启动：

```ts
server.addHook("agent.open.before", async ({ request }) => ({
  ...request,
  wrap: ["/usr/local/bin/sandbox-run", "--profile", "agent"],
}));
```

- Provider 快照条目中 `launchWrap: true` 的 Provider 会应用包装。所有内置 Provider 和所有自定义 ACP Provider 都支持。插件 Provider 声明支持后也会应用包装，例如 Muse Code 和 Antigravity 等 ACP 插件 Provider。在 `agent.create.before` 中用 `paseo.providers.snapshot()` 读取该字段，并在那里选择 Provider。为其他 Provider 返回包装会让打开失败，包装绝不会被丢弃。
- 读取历史的打开也保留包装。
- 带包装的 OpenCode 会话会获得自己的 OpenCode 服务器，该服务器在包装之后启动。配置为使用现有服务器的 OpenCode Provider 无法启动服务器，因此带包装的打开会失败。
- harness 不一定在 Agent 的目录中启动。Codex 在 daemon 的目录中启动它，OpenCode 在 Paseo 主目录下的 `opencode-home` 目录中启动其服务器。两者都通过各自的协议发送会话目录。如果启动器需要该目录，把 `request.cwd` 放进包装的参数中。
- 在包装内保持系统临时目录可见。Paseo 在启动 Pi 之前把 Pi 扩展写入该目录，Claude Code 也把工具输出写入该目录。如果启动器用一个空的私有目录遮住它，这些会话就会失败。
- 包装覆盖 Paseo 为会话启动的进程：harness、Paseo 为 Agent 托管的 stdio MCP 服务器，以及 ACP Agent 请求 Paseo 运行的终端。Paseo 的主机终端工具、Provider 可用性和目录探测以及草稿发现都在包装之外运行。

### 在每次打开会话时追加指令 {#append-instructions-on-every-session-opening}

```ts
server.addHook("agent.open.before", async ({ request }) => ({
  ...request,
  appendSystemPrompt: [...(request.appendSystemPrompt ?? []), "Follow the team engineering guide."],
}));
```

插件指令按插件顺序追加在已保存的 Agent 提示词和 daemon 指令之后。指令不会保存到 Agent 配置中，读取历史时也会忽略这些指令。插件数据更改后，重新加载插件以在下次重新打开会话时应用新指令。正在运行的轮次会继续。移除指令不会删除对话历史。内部 Agent 也会收到这些指令。ACP 适配器不会向 Provider 发送系统指令。插件 Provider 会收到组合后的提示词，但需要自行应用。

更新 Codex 指令需要 Codex 0.121.0 或更新版本，且 app server 报告的版本必须可识别。版本显示为 `0.0.0` 的源码构建需要换用带版本号的构建。Paseo 会向现有会话添加当前指令快照；之前的快照仍保留在对话中。更新期间发生崩溃或回退会话时，快照可能重复。

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
  if (request.provider !== "codex" || request.background) return;

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
| 后台 Agent | `request.background`                         |

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

实时轮次完成、失败或取消后触发，收到 `{ agent, turnId, outcome }`。`outcome.kind` 为 `completed`、`failed` 或 `canceled`。载荷不含历史。请从 Agent 的时间线读取本轮：`refetch({ direction: "tail", limit: 1, wholeTurns: true })` 会完整返回最近一轮，见下面的示例。只保留 `turnId` 等于 `event.turnId` 的条目：如果在读取前已有新一轮开始（例如另一个插件发送的后续消息），最近一轮就不再是本轮。此时过滤后的列表为空；`event.turnId` 为 `null` 时也为空。基于旧版 SDK 构建、仍读取 `event.timeline` 的插件只会拿到空数组。

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
    const page = await agent.timeline.refetch({ direction: "tail", limit: 1, wholeTurns: true });
    const turn = page.entries.filter((entry) => entry.turnId === event.turnId);
    const text = latestOutputText(turn.map(({ item }) => item));
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

## 后台 Agent {#background-agents}

Agent 钩子不包括 daemon 的私有临时辅助 Agent。后台 Agent 和后台工作区中的 Agent 使用相同钩子。

[后台 Agent](/docs/sdk/agents#run-a-helper-as-a-background-agent) 是不出现在标签页、列表和提醒中的辅助 Agent。对后台 Agent，每个钩子的 `agent.background` 以及 `agent.open.before` 请求的 `background` 都为 `true`，无需额外查询即可跳过它：

```ts
server.addHook("agent.turn.after", async ({ agent }) => {
  if (agent.background) return; // A helper reports to the agent that created it.
  await notifyTeam(agent);
});
```

`background` 在创建 Agent 时确定，钩子无法修改。在后台工作区中创建但没有传 `background: true` 的 Agent 读取到 `false`。早于 0.16.0 的主机不发送该字段，读取结果为 `undefined`。

## 顺序与返回值 {#ordering-and-returned-values}

```text
Creation request
  → agent.create.before hooks (plugin-ID order; registration order within each plugin)
  → resolve defaults and validate provider configuration
  → derive launch configuration with Paseo runtime tools and daemon prompt
  → agent.open.before hooks (same ordering; env and plugin-local tools and MCP servers)
  → set PASEO_AGENT_ID, PASEO_AGENT_CWD, and PASEO_WORKSPACE_ID when the agent has a workspace
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

| 插件                                                                                                   | 包含                                                                |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| [lifecycle-logger](https://github.com/getpaseo/paseo/tree/main/plugin-examples/lifecycle-logger)       | Agent、工作区、worktree、终端和命令钩子；隐去环境变量值的 JSON 日志 |
| [lifecycle-actions](https://github.com/getpaseo/paseo/tree/main/plugin-examples/lifecycle-actions)     | 后续消息、权限、环境变量、切换 Provider、选择 worktree              |
| [agent-configuration](https://github.com/getpaseo/paseo/tree/main/plugin-examples/agent-configuration) | MCP 注入以及 Codex 沙盒/批准选项                                    |
| [agent-tools](https://github.com/getpaseo/paseo/tree/main/plugin-examples/agent-tools)                 | 按标签选择 Agent，并在插件进程中执行文件操作的工具                  |
| [worktrunk](https://github.com/getpaseo/paseo/tree/main/plugin-examples/worktrunk)                     | worktree 管理器（`create`、`remove`、`restore`）与 Agent 活动标记   |

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
