---
title: 触发器 YAML 参考
description: .paseo/triggers/*.yml 中自包含 Hub 触发器文档的完整字段参考。
nav: 触发器 YAML 参考
---

# 触发器 YAML 参考 {#trigger-yaml-reference}

每个 `.paseo/triggers/<name>.yml` 文件定义一个自包含的 Hub 触发器。Hub 控制台的 YAML 视图和 `POST /api/v1/triggers/install` 接受相同的格式。

## 顶层字段 {#top-level-fields}

| 字段          | 必填 | 默认值            | 说明                                                                                        |
| ------------- | ---- | ----------------- | ------------------------------------------------------------------------------------------- |
| `name`        | 是   | 无                | 唯一触发器标识符（`^[a-z][a-z0-9_-]*$`）。重新部署会按 `name` 更新。                        |
| `enabled`     | 否   | `true`            | 禁用的触发器保留配置，并停止接受新运行。                                                    |
| `on`          | 是   | 无                | 非空映射，键为事件名，值为事件定义（`connection`、`filters`、`recurrence`）。               |
| `inputs`      | 否   | 无                | 带类型的调用头部（`type: string \| number \| boolean`、`required`、`default`、`choices`）。 |
| `max_runtime` | 否   | `run.max_runtime` | 整次触发运行的硬性上限，最长 `24h`。                                                        |
| `run`         | 是   | 无                | 目标 daemon、Agent 配置、会话延续、提示词、运行限制、工具和输出。                           |

## 事件定义（`on`） {#event-definitions-on}

`on` 下的每个键都是一个事件名：

- Provider 事件（`github.*`、`linear.*`、`slack.mention`、`discord.mention`）接受可选的 `connection`（集成 slug）和 `filters`。完整事件和过滤条件表见[触发器](/docs/hub/triggers#events)。
- `schedule.tick` 要求设置 `recurrence`（`start`、`rule`、`timezone`），并拒绝 `connection` 和 `filters`。参见[定时触发器](/docs/hub/triggers/schedules)。
- `webhook.received` 接受空对象 `{}`，并拒绝 `connection` 和 `filters`。参见[入站 webhook](/docs/hub/triggers/webhooks)。
- `manual.run` 接受 `{}` 或用于 API 派发的 `filters.from_users`。参见 [Hub 公开 API](/docs/hub/api#manual-run-dispatch)。

一个触发器文档可以在 `on` 下声明多个事件。控制台的可视化表单编辑单事件触发器，多事件触发器可在 YAML 视图中编辑。

## 目标与 worktree {#target-and-worktree}

`run.target` 选择执行 Agent 的 daemon 和目录：

| 字段       | 必填 | 说明                                                                         |
| ---------- | ---- | ---------------------------------------------------------------------------- |
| `daemon`   | 是   | 拥有 `hub.execute` 权限的已连接 daemon slug。                                |
| `cwd`      | 是   | 该 daemon 上已有的目录，使用以 `/` 开头的绝对路径。                          |
| `worktree` | 否   | 可选的 git worktree 模式：`branch-off`、`checkout-branch` 或 `checkout-pr`。 |

例如，`/home/me/project` 符合路径格式。Hub 会拒绝 `C:\work\project` 这类 Windows 盘符路径。

worktree 模式：

- `branch-off`：需要 `newBranch` 和可选的 `base`。在 `newBranch` 中嵌入 `${{ paseo.execution.id }}`（例如 `trigger-${{ paseo.execution.id }}`），让每次执行获得唯一分支并在重试时保持一致。`newBranch` 只接受 `${{ paseo.execution.id }}` 表达式。
- `checkout-branch`：需要字面量 `branch`。
- `checkout-pr`：需要正整数 `prNumber`。

## Agent 选择 {#agent-selection}

`run.agent` 可以定义一个静态 Agent 配置，或通过输入在有限选项中进行选择：

| 字段               | 必填 | 说明                                                                                                   |
| ------------------ | ---- | ------------------------------------------------------------------------------------------------------ |
| `provider`         | 是   | 目标 daemon 上配置的任意 Provider（例如 `codex`、`claude`、`opencode`、`pi` 或自定义/插件 Provider）。 |
| `model`            | 否   | Provider 模型 ID。                                                                                     |
| `mode`             | 否   | Provider 执行模式 ID。当 Provider 提供模式时，控制台表单要求填写。                                     |
| `thinkingOptionId` | 否   | Provider 思考选项 ID。                                                                                 |
| `options`          | 否   | JSON 安全的 Provider 原生选项对象，原样透传不重命名。                                                  |

保存或部署时，Hub 会请已连接的 daemon 校验 `provider`、`model`、`mode`、`thinkingOptionId` 和 `options`。

如需让调用输入在若干完整的预定义 Agent 配置之间选择，请使用 `select` 和 `choices`：

```yaml
name: choose-agent
on:
  manual.run: {}
inputs:
  agent:
    type: string
    required: true
    choices: [codex-read, claude-work]
run:
  target:
    daemon: devbox
    cwd: /workspace/project
  agent:
    select: ${{ paseo.inputs.agent }}
    choices:
      codex-read:
        provider: codex
        mode: read-only
      claude-work:
        provider: claude
        mode: bypassPermissions
  prompt: Handle this request and call finish_execution.
```

内联 Agent 对象中的动态字段会被拒绝。`select` 的每一个可能结果都必须对应 `choices` 中的键。

## Agent 延续 {#agent-continuation}

`run.continuation` 控制新到达的事件是复用现有 Agent 还是启动新 Agent：

| 值                                                        | 行为                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `{ mode: conversation }`                                  | 默认值。在同一 Slack 或 Discord 讨论串、GitHub issue 或 PR、Linear issue 上复用 Agent；无对话时启动新 Agent。 |
| `{ mode: key, key: "ticket-${{ paseo.inputs.ticket }}" }` | 按求值后的键复用 Agent（最长 512 个字符的非空字符串）。                                                       |
| `{ mode: new }`                                           | 每次到达都启动全新的 Agent。                                                                                  |

持续运行的 Agent 会保留原有的 daemon、工作目录、worktree 分支、Agent 配置、`background` 标志和工具授权。如果对同一个延续键修改其中任一项，运行会失败，需先切换到 `{ mode: new }` 或更换延续键。

当 Agent 正忙时到达的后续事件会引导正在运行的 Agent，但不会延长原运行超时。调用 `reply` 和 `finish_execution` 时请传入提示词中的 `executionId`，确保输出绑定到正确的请求。

## 提示词、上下文与标题 {#prompt-context-and-title}

| 字段              | 必填 | 默认值  | 说明                                                                    |
| ----------------- | ---- | ------- | ----------------------------------------------------------------------- |
| `prompt`          | 是   | 无      | 发送给 Agent 的指令文本。                                               |
| `title`           | 否   | 无      | 可选的 Paseo 工作区标题模板（字面文本加 `${{ paseo.execution.id }}`）。 |
| `max_runtime`     | 否   | `2h`    | 运行硬性上限，最长 `24h`。                                              |
| `idle_timeout`    | 否   | `10m`   | 空闲超时，不能超过 `max_runtime`。                                      |
| `startup_timeout` | 否   | `2m`    | 创建 worktree 和启动 Provider 的等待预算，最长 `24h`。                  |
| `auto_archive`    | 否   | `true`  | 执行结束后归档工作区。                                                  |
| `background`      | 否   | `false` | 创建在默认工作区列表中隐藏的后台工作区。旧版 daemon 会忽略它。          |

提示词表达式：

- `${{ paseo.prompt }}` 插入 Provider 事件收到的完整消息文本，或 `webhook.received` 包装后的 webhook 请求体。对于 `webhook.received`，省略 `${{ paseo.prompt }}` 时会自动追加包装后的请求体。
- `${{ paseo.context }}` 为本次运行显式开启 Provider 上下文物化（讨论串历史、issue 元数据、定时元数据或附件描述符），以 JSON 渲染。除非显式编写 `${{ paseo.context }}`，Hub 不会自动注入环境上下文。
- `${{ paseo.inputs.<name> }}` 插入已声明的输入值。

请用清晰边界（例如 `<user-prompt>...</user-prompt>`）包裹不可信外部文本。

## 输出能力 {#output-capabilities}

Hub 会为每次运行挂载执行 MCP 服务器，并始终提供 `finish_execution`。

当事件有关联的 issue、Pull Request 或讨论串可供回复时，Hub 会授予 `reply` 工具。默认情况下，回复可选且不限次数。

`github.push` 事件没有回复目标。如果为推送事件设置 `run.outputs.github.reply.required: true`，Hub 会在启动 Agent 前将运行标记为失败。

通过 `run.outputs` 设置 `max` 可限制回复次数，也可以要求 Agent 在调用 `finish_execution` 前至少回复一次。

```yaml
run:
  outputs:
    slack.reply:
      max: 1
      required: true
```

支持的回复能力键为 `github.reply`、`linear.reply`、`slack.reply` 和 `discord.reply`。Hub 不会改写提示词，因此需要在提示词中告诉 Agent 何时调用 `reply` 和 `finish_execution`。

如需在 `finish_execution` 上要求结构化 JSON 输出，请将 `run.output.schema` 设为 JSON Schema 对象。

## 工具、GitHub 与环境变量 {#tools-github-and-environment}

- `run.tools` 授予受控的 Slack 和 Discord MCP 工具（针对显式频道 ID 的 `read` 和 `post`）。参见[集成工具](/docs/hub/tools)。
- `run.github` 签发受控的 `GH_TOKEN` 和隔离的 git 配置。参见 [GitHub 访问](/docs/hub/github)。
- `run.env` 注入环境变量，包括 `${{ paseo.connections.<slug>.token }}`。
