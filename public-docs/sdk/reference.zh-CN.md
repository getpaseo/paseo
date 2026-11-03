---
title: SDK API 参考
description: "@getpaseo/client 的公开配置、方法、句柄、结果、默认值和生命周期行为。"
nav: API 参考
---

# SDK API 参考 {#sdk-api-reference}

所有受支持的运行时值和 TypeScript 类型都从 `@getpaseo/client` 导入。

## `createPaseoClient(config)` {#createpaseoclientconfig}

创建一个客户端，但不打开连接。

必填配置：

| 字段  | 类型     | 含义                                   |
| ----- | -------- | -------------------------------------- |
| `url` | `string` | daemon 的 WebSocket 端点，包含 `/ws`。 |

常用的可选配置：

| 字段                    | 类型          | 默认值       | 含义                                      |
| ----------------------- | ------------- | ------------ | ----------------------------------------- |
| `clientId`              | `string`      | 自动生成     | 用于日志和订阅的稳定标识符。              |
| `password`              | `string`      | 未设置       | daemon 密码。                             |
| `authHeader`            | `string`      | 未设置       | 用于代理的完整 Authorization 请求头的值。 |
| `connectTimeoutMs`      | `number`      | 客户端默认值 | 连接截止时间。                            |
| `reconnect.enabled`     | `boolean`     | 客户端默认值 | 意外断开后重新连接。                      |
| `reconnect.baseDelayMs` | `number`      | 客户端默认值 | 首次重连的延迟。                          |
| `reconnect.maxDelayMs`  | `number`      | 客户端默认值 | 重连的最大延迟。                          |
| `logger`                | `PaseoLogger` | 未设置       | 接收 debug、info、warning 和 error 日志。 |

使用中继端到端加密的客户端还可以传入 `e2ee.enabled` 和 `e2ee.daemonPublicKeyB64`。`appVersion`、`runtimeGeneration` 和运行时指标选项供 Paseo 自己的客户端界面使用；普通集成可以省略它们。

## 客户端生命周期 {#client-lifecycle}

| 方法                   | 结果              | 行为                                                                   |
| ---------------------- | ----------------- | ---------------------------------------------------------------------- |
| `connect()`            | `Promise<void>`   | 在 daemon 发送其服务器信息后 resolve。                                 |
| `close()`              | `Promise<void>`   | 关闭连接并释放此客户端。                                               |
| `ensureConnected()`    | `void`            | 除非客户端已连接，否则抛出错误。                                       |
| `getConnectionState()` | `ConnectionState` | 返回 `idle`、`connecting`、`connected`、`disconnected` 或 `disposed`。 |

调用 `close()` 后请创建新的客户端。

## `client.agents` {#clientagents}

| 方法                 | 结果                   | 行为                                                                                      |
| -------------------- | ---------------------- | ----------------------------------------------------------------------------------------- |
| `list(options?)`     | `PaseoAgentListResult` | 列出一页 Agent。`scope`、`filter`、`sort`、`page` 和 `subscribe` 与 daemon 目录查询一致。 |
| `create(options)`    | `PaseoAgentHandle`     | 为 `cwd` 创建一个 Agent 和一个新的工作区。需要 `config`。                                 |
| `ref(agentOrId)`     | `PaseoAgentHandle`     | 创建一个本地句柄，不发起请求。                                                            |
| `subscribe(handler)` | 取消订阅函数           | 此 API 实例的本地监听器。需要一个由你持有的 `list({ subscribe: {} })` 观察。              |

`list({ subscribe: {} })` 还会返回一个 `subscriptionId` 和一个由你持有的 `subscription`。它的 `subscribe({ snapshot, update, error? })` 回调会先收到快照，再收到限定范围的线上更新；`release()` 结束这次观察。支持该能力的 daemon 会分配 ID，并让各个观察相互独立。较旧的 daemon 使用本地 ID 及其既有的共享投递行为。普通的列表调用不会创建观察。工作区列表遵循同样的契约。见[事件](./events.md)。

创建选项包括 `config`、`cwd`、`parent`、`title`、`prompt`、`env`、`outputSchema`、`images`、`attachments`、`git`、`worktree`、`autoArchive`、`background` 和 `labels`。

`parent` 接受主机本地的 Agent ID、`AgentAddress`（`{ serverId, agentId }`）或 Agent 句柄。句柄的 `address` 在断开连接后仍保留其主机身份。通过 `hosts.client(serverId)` 创建时，请传入父 Agent 句柄或完整地址；SDK 会把父级元数据带到目标主机。

`background` 表示创建工作区的意图。它不能与已有的 `workspaceId` 一起使用。调用方继承规则和包含后台的发现方式见[后台工作区](./workspaces.md)。

`config` 接受：

| 字段               | 类型                      | 含义                                                                          |
| ------------------ | ------------------------- | ----------------------------------------------------------------------------- |
| `provider`         | `string`                  | 必填的 `provider/model` 选择。                                                |
| `modeId`           | `string`                  | Provider 的运行模式或权限模式。                                               |
| `thinkingOptionId` | `string`                  | Provider 的推理级别。                                                         |
| `featureValues`    | `Record<string, unknown>` | 通过 `providers.listFeatures` 发现的功能的取值。                              |
| `options`          | JSON 对象                 | Provider 原生设置，严格校验。见 [Provider 选项](/docs/sdk/provider-options)。 |
| `systemPrompt`     | `string`                  | 额外的系统或开发者指令。                                                      |
| `mcpServers`       | MCP 服务器映射            | 作用于会话的 MCP 服务器。                                                     |
| `toolPolicy`       | MCP 工具策略              | MCP 工具的精确预批准规则。                                                    |

### Agent 句柄 {#agent-handle}

| 成员                           | 结果                              | 行为                                                                    |
| ------------------------------ | --------------------------------- | ----------------------------------------------------------------------- |
| `id`                           | `string`                          | 稳定的 daemon Agent ID。                                                |
| `address`                      | `AgentAddress`                    | 完整的 `{ serverId, agentId }` 身份；需要连接到主机才能确定。           |
| `workspaceId`                  | `string \| null`                  | 当前所在的工作区。                                                      |
| `cwd`                          | `string \| null`                  | 当前工作目录。                                                          |
| `status`                       | Agent 状态或 `null`               | 当前的生命周期状态。                                                    |
| `capabilities`                 | 能力标志或 `null`                 | Provider 会话支持的能力。                                               |
| `availableModes`               | Agent 模式或 `null`               | 会话可以切换到的模式。                                                  |
| `pendingPermissions`           | 权限请求或 `null`                 | 等待回应的请求。                                                        |
| `activeTurn`                   | 当前轮次或 `null`                 | 正在进行的轮次，包含 `turnId` 和 `startedAt`。                          |
| `lastUsage`                    | 用量或 `null`                     | 上一轮的 token 数、费用和上下文窗口用量。                               |
| `lastError`                    | `string \| null`                  | daemon 为该 Agent 记录的最后一个错误。                                  |
| `features`                     | Agent 功能或 `null`               | Provider 的功能开关和选择项及其当前值。                                 |
| `runtimeInfo`                  | 运行时信息或 `null`               | 实时的 Provider、会话 ID、模型、思考选项和模式。                        |
| `archivedAt`                   | `string \| null`                  | 归档时间戳；Agent 处于活动状态时为 `null`。                             |
| `current()`                    | `PaseoAgent \| null`              | 此句柄观察到的当前详细值；从不发起请求。                                |
| `refresh(requestId?)`          | `PaseoAgentRefetchResult \| null` | 获取当前的 Agent 及其所在项目。                                         |
| `send(text, options?)`         | `Promise<void>`                   | 在 daemon 接受提示词后 resolve。                                        |
| `respondToPermission(options)` | `Promise<void>`                   | 按 `requestId` 以允许或拒绝的 `response` 回应一个待处理的权限请求。     |
| `run(text, options?)`          | `PaseoAgentRunResult`             | 发送提示词并等待该轮结束。`timeoutMs` 控制等待时间，默认 10 分钟。      |
| `waitForFinish(timeoutMs?)`    | `PaseoAgentRunResult`             | 等待当前轮次结束，包括初始提示词。默认超时：10 分钟。                   |
| `commands(options?)`           | `PaseoAgentCommandsResult`        | 向正在运行的会话查询它的斜杠命令和技能，包括内置的。选项：`requestId`。 |
| `subscribe(handler)`           | 取消订阅函数                      | 把 Agent 目录更新过滤到此 ID，并刷新句柄的属性。                        |
| `archive()`                    | `{ archivedAt }`                  | 软删除 Agent 并关闭它的运行时。                                         |
| `detach()`                     | `Promise<void>`                   | 解除父子关系，但不停止 Agent。                                          |

从 `workspaceId` 到 `archivedAt` 的属性反映句柄最近观察到的快照。由 `ref()` 得到的句柄在 `refresh()`、`run()`、`waitForFinish()`、时间线重新获取或 `subscribe()` 投递快照之前，这些属性都读作 `null`。已观察到的快照中的可选值也读作 `null`。当你需要整个快照，或需要区分这些状态时，请调用 `current()`。

`PaseoAgentRunResult` 包含 `status`、`final`、`error` 和 `lastMessage`。存在 `final` 时会刷新句柄。

`PaseoAgentCommandsResult` 包含 `agentId`、`commands` 和 `error`。每条命令都有 `name`、`description`、`argumentHint`，以及取值为 `"command"` 或 `"skill"` 的可选 `kind`。无法回答的 Provider 会在 `error` 中报告，而不是 reject；完全不提供命令列表的 Provider 返回空数组。

### 时间线句柄 {#timeline-handle}

`agent.timeline.refetch(options?)` 获取一页时间线。选项有 `direction`、`cursor`、`limit`、`projection` 和 `requestId`。

`agent.timeline.subscribe(handler)` 为该 Agent 建立网络订阅需求，并在重连后恢复它。它返回的取消订阅函数会释放这项需求；开始工作之前，请 await `unsubscribe.ready` 以等待 daemon 的初始确认。投递只包含实时内容。重连时会发出一个本地的 `subscription_restored` 事件；错过的历史请用 `refetch()` 显式请求。实时的替换会使之前的 epoch 失效。回调的形状、分页和失败行为见[时间线事件](./events.md#follow-timeline-events)。

## `client.projects` {#clientprojects}

| 方法                 | 结果                     | 行为                                                                   |
| -------------------- | ------------------------ | ---------------------------------------------------------------------- |
| `list(options?)`     | `PaseoProjectListResult` | 列出每个已注册的项目，包括没有活动工作区的项目。                       |
| `subscribe(handler)` | 取消订阅函数             | 请求之后的项目更新；取消订阅会释放这项需求。初始状态由 `list()` 提供。 |

显式的事件观察和清理见[事件](./events.md#follow-provider-catalog-changes)。

## `client.workspaces` {#clientworkspaces}

| 方法                     | 结果                          | 行为                                                                                                      |
| ------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `list(options?)`         | `PaseoWorkspaceListResult`    | 列出、过滤、分页或订阅工作区目录。                                                                        |
| `open(cwd)`              | `PaseoWorkspaceHandle`        | 复用某个目录的活动工作区，或创建一个。                                                                    |
| `create(options)`        | `PaseoWorkspaceHandle`        | 总是创建一个新的、由目录或 Paseo worktree 支撑的工作区。`background: true` 会把它从默认的发现结果中隐藏。 |
| `ref(workspaceOrId)`     | `PaseoWorkspaceHandle`        | 创建一个本地句柄。                                                                                        |
| `archive(workspaceOrId)` | `PaseoWorkspaceArchiveResult` | 无需先创建句柄即可归档。                                                                                  |
| `subscribe(handler)`     | 取消订阅函数                  | 此 API 实例的本地监听器。需要一个由你持有的 `list({ subscribe: {} })` 观察。                              |

`create({ source, agent, background })` 会同时创建一个工作区及其初始 Agent。`agent` 接受除 `worktree`、`git`、`onEvent`、`idempotencyKey` 和 `requestId` 之外的 Agent 创建选项。请在工作区选项上设置 `background`；`agent.background` 会被拒绝。见[一次性创建的示例](./agents.md#run-work-in-a-background-workspace)。

工作区句柄提供 `id`、`projectId`、`directory`、`name`、`status`、`current()`、`refresh()`、`setTitle(title)`、`archive()` 和 `subscribe()`。向 `setTitle` 传入 `null` 会恢复推导出的工作区名称。使用 `workspace.agents.create(options)` 创建 Agent，无需重复提供工作区 ID 或目录。

## `client.terminals` {#clientterminals}

终端操作需要一个支持工作区终端的主机。较旧的主机不会收到任何终端请求；SDK 会抛出一个要求更新主机的错误。

| 方法                | 结果                               | 行为                                                                  |
| ------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| `create(options)`   | `Promise<PaseoTerminalHandle>`     | 创建一个归必填的 `workspaceId` 所有的终端。                           |
| `list(options?)`    | `Promise<PaseoTerminalListResult>` | 返回 `{ entries, requestId }`。省略过滤条件时列出此主机上的所有终端。 |
| `ref(terminalOrId)` | `PaseoTerminalHandle`              | 创建一个本地句柄，不发起请求，也不附加终端流。                        |

创建选项：

| 字段              | 含义                                                             |
| ----------------- | ---------------------------------------------------------------- |
| `workspaceId`     | 必填的活动工作区 ID。未知或已归档的 ID 会失败。                  |
| `cwd`             | 可选的进程绝对工作目录。默认为工作区目录；修改它不会改变所有权。 |
| `name`            | 可选的终端名称。                                                 |
| `command`、`args` | 可选的可执行文件和参数数组。省略时启动默认 shell。               |
| `size`            | 可选的初始视口：`{ rows, cols }`。                               |
| `requestId`       | 可选的请求关联 ID。                                              |

列表选项有 `workspaceId`、`cwd` 和 `requestId`。`workspaceId` 按所有权筛选，包括在工作区目录之外启动的终端。提供它时，`cwd` 不会限制结果。没有 ID 时，`cwd` 按工作区根目录过滤。每个条目包含 `id`、`workspaceId`、`cwd` 和 `name`；`cwd` 是终端实际的起始目录。

终端句柄提供：

| 方法                | 结果                                  | 行为                                                                   |
| ------------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| `current()`         | `PaseoTerminal \| null`               | 来自创建、`ref(snapshot)` 或刷新的最近快照。由 ID 创建的句柄起初为空。 |
| `refresh(options?)` | `Promise<PaseoTerminal \| null>`      | 获取终端快照；终端已不存在时返回 `null`。接受 `requestId`。            |
| `write(data)`       | `number`                              | 发送字面文本，不解释按键名称。返回输入的 UTF-16 长度。                 |
| `sendKeys(keys)`    | `number`                              | 展开按键标记并发送组合后的输入。返回其 UTF-16 长度。                   |
| `capture(options?)` | `Promise<PaseoTerminalCaptureResult>` | 返回 `{ terminalId, lines, totalLines, requestId }`。                  |
| `kill(requestId?)`  | `Promise<void>`                       | 等待终端销毁完成。结束一个已被移除的终端也会成功。                     |

`sendKeys()` 识别 `Enter`、`Tab`、`Escape`、`Space`、`BSpace`、`C-c`、`C-d`、`C-z`、`C-l`、`C-a` 和 `C-e`。其他字符串按字面传递。输入方法发送后不会等待命令执行，也不会确认终端已消费输入。

capture 接受可选的 `start`、`end`、`stripAnsi` 和 `requestId`。行范围从零开始、包含两端，跨越回滚缓冲区和视口。负数范围从末尾开始计数；省略范围时捕获所有行。`stripAnsi` 默认为 `true`。终端不存在时返回空行。

使用 `workspace.terminals.create(options?)` 和 `workspace.terminals.list(options?)` 可以从句柄提供工作区 ID。创建接受除 `workspaceId` 之外的相同选项；列表只接受 `requestId`。插件通过 `usePaseo()` 和处理函数的 `paseo` context 获得这些方法。

## `client.providers` {#clientproviders}

| 方法                             | 结果                          | 行为                                                                                                             |
| -------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `waitForReady(options?)`         | `PaseoProviderSnapshotResult` | 等待直到没有 Provider 处于加载中。默认超时：60 秒。当 daemon 无法关联工作区快照时，以要求更新主机的错误 reject。 |
| `snapshot(options?)`             | `PaseoProviderSnapshotResult` | 立即返回当前目录。                                                                                               |
| `refresh(options?)`              | 确认                          | 强制刷新所有或所选 Provider 的目录。                                                                             |
| `listAvailable()`                | 可用性结果                    | 报告已安装 Provider 的可用性。                                                                                   |
| `listModels(provider, options?)` | 模型结果                      | 为某个 Provider 和目录发现模型。                                                                                 |
| `listModes(provider, options?)`  | 模式结果                      | 发现权限模式或运行模式。                                                                                         |
| `listFeatures(draftConfig)`      | 功能结果                      | 为当前草稿 Provider 配置发现功能。                                                                               |
| `diagnostic(provider)`           | 诊断结果                      | 返回人类可读的设置诊断信息。                                                                                     |
| `listUsage(options?)`            | `PaseoProviderUsageResult`    | 返回规范化的订阅窗口、余额和 Provider 详情。不支持时以要求更新主机的错误 reject。选项：`requestId`。             |
| `subscribe(handler)`             | 取消订阅函数                  | 请求之后的目录更新；取消订阅会释放这项需求。                                                                     |

## `client.config` {#clientconfig}

`config.get(requestId?)` 返回 daemon 的可变配置。

`config.patch(patch, requestId?)` 会校验、持久化并返回更新后的配置。这个管理接口用于主机配置，而不是针对单个 Agent 的选择。一次 patch 会影响使用该 daemon 的每个客户端和之后的每个 Agent。

## `client.hosts` {#clienthosts}

管理连接到所选 daemon 的主机。管理连接的 daemon 和目标主机都必须支持已连接主机功能。

```ts
const directory = await client.hosts.list();
const registration = await client.hosts.add({
  connection: "ssh://deploy@build-box",
  label: "Build box",
  metadata: { team: "infra" },
  sourceKey: "build-box",
});
await client.hosts.update(registration.registrationId, { enabled: false });
await client.hosts.remove(registration.registrationId);
```

`list()` 返回 `{ self: { serverId, label }, hosts }`。每个主机包括注册 ID 和服务器 ID、标签、经过认证的来源、字符串元数据、启用状态、连接状态、不含凭据的目标描述、上次在线和重试时间戳，以及带恢复说明的错误。它不会返回凭据。
语法有效但无法访问的连接会被保存并重试。无效语法会直接报错，不会保存。

`update(registrationId, patch)` 接受 `label`、`metadata`、`enabled`、`connection` 和 `replaceIdentity`。
元数据会替换整个映射。替换连接会保留预期的服务器 ID，除非通过 `replaceIdentity: true` 显式接受新目标。

`observe()` 返回一个由调用方持有的订阅。等待 `ready`，订阅快照和 `hosts.changed` 更新，然后调用 `release()`。
重新连接后，观察会恢复并提供当前快照。

```ts
const remote = await client.hosts.client("srv_build_box");
try {
  const workspaces = await remote.workspaces.list();
  const providers = await remote.providers.listAvailable();
  await remote.agents.ref("agent_on_build_box").send("Continue the investigation");
} finally {
  await remote.dispose();
}
```

`client(serverId)` 返回一个由调用方持有的 `PaseoApi`，通过所选 daemon 绑定到该目标。
普通 API 的签名不变。路径和 ID 属于目标主机。选择本地服务器 ID 会返回本地作用域。路由支持一跳。

释放一个作用域会释放它的观察，不会关闭同级作用域或删除已保存的主机。
释放源作用域会同时释放派生作用域。观察通过普通客户端生命周期恢复。
连接过程中，新请求使用现有的有界发送队列；断开连接时请求会失败。连接丢失会清除旧的等待项和排队发送项。
普通的不可恢复请求不会重放；现有的已确认或幂等创建恢复会保留其请求身份。
已提交但响应丢失的请求会以 `DaemonConnectionError` 拒绝（`code: "DAEMON_CONNECTION_LOST"`），
并附带可选的 `outcome: "unknown"` 和已知的 `serverId`。重试修改操作前，请先检查目标状态。

注册和获取主机失败时会提供稳定的 `code`：`host_unknown`、`host_disabled`、`host_offline`、
`permission_denied`、`unsupported_capability`、`authentication_failed`、`server_id_mismatch`、
`self_host` 或 `duplicate_host`。普通 RPC 权限代码（包括 `access_denied`）保持不变。
多路复用属于传输层；调用方使用相同的客户端/API 操作和生命周期。发现主机不会授予执行权限。

## 错误与清理 {#errors-and-cleanup}

连接、校验、拒绝和超时失败都会让对应的 promise reject。轮次的结果通过 `PaseoAgentRunResult.status` 返回，因为权限和 Provider 错误是 Agent 预期内的状态。

请始终在 `finally` 中关闭客户端。关闭客户端会移除它的本地监听器和网络连接；它不会停止 Agent，也不会归档工作区。
