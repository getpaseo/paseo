---
title: Hub 配置参考
description: Hub 资源、workflow、Agent、表达式和提示词字段的标准参考。
nav: 配置参考
---

# Hub 配置参考 {#hub-configuration-reference}

Hub 接受以下结构的 YAML：

```text
.paseo/
├── hub.yml
└── workflows/
    ├── <workflow>.yml
    └── partials/
        └── <partial>.md
```

只有 `.paseo/workflows/` 下直接的 `.yml` 子文件才是 workflow。每个文件包含一个触发器及其有序的 step。没有 manifest、`includes`、`uses`、可复用的 step、workflow 调用或继承。

## `hub.yml` {#hubyml}

`.paseo/hub.yml` 包含具名的项目资源。名称是映射的键，不会在每个对象内部重复。

```yaml
environments:
  paseo:
    kind: daemon
    daemon: laptop
    cwd: /Users/you/code/paseo
  hub:
    kind: daemon
    daemon: devbox
    cwd: /workspace/hub

agents:
  codex-safe:
    provider: codex
    model: gpt-5.5
    thinkingOptionId: xhigh
    options:
      sandbox_workspace_write:
        writable_roots: [/var/cache/npm]
        network_access: false
  claude:
    provider: claude
    mode: bypassPermissions
```

顶层只有 `environments` 和 `agents` 两个键。`triggers` 键会被拒绝，并给出迁移错误。

### 环境 {#environments}

| 字段       | 是否必填   | 说明                                                                 |
| ---------- | ---------- | -------------------------------------------------------------------- |
| `kind`     | 是         | `daemon`、`fly` 或 `docker`；workflow 的 step 必须选择 daemon 环境。 |
| `daemon`   | 仅 daemon  | 已注册的 daemon slug，在修订激活时解析。                             |
| `cwd`      | 仅 daemon  | daemon 上的绝对工作目录。                                            |
| `image`    | fly/docker | 镜像名称。                                                           |
| `worktree` | 否         | `branch-off`、`checkout-branch` 或 `checkout-pr` 目标。              |

对于 `worktree`，`branch-off` 使用 `newBranch` 和可选的 `base`，`checkout-branch` 使用 `branch`，`checkout-pr` 使用正整数 `prNumber`。

```yaml
environments:
  review:
    kind: daemon
    daemon: build-server
    cwd: /workspace/project
    worktree:
      mode: branch-off
      newBranch: trigger-${{ paseo.execution.id }}
      base: origin/main
```

`newBranch` 是一个分支名字符串。在其中嵌入 `${{ paseo.execution.id }}`，它会渲染为该次执行的 UUID，这样每次执行都会从 `base` 分出自己的分支，并在 Hub 重试或恢复该执行时保留这个分支。

一次执行就是一次 step 运行，因此选择同一环境的两个 step 会得到各自独立的分支。

`${{ paseo.execution.id }}` 是 `newBranch` 唯一接受的表达式。`paseo.prompt`、`paseo.context`、`paseo.inputs.*`、`values.*`、`steps.<id>.outputs.*` 以及 Provider 事件字段在这里都不可用，任何一个都会在编写它的字段处导致文件包激活失败，例如 `.paseo/hub.yml.environments.review.worktree.newBranch`。

`${{ paseo.execution.id }}` 出现在文件包中其他任何位置时，同样会导致激活失败。`branch` 和 `prNumber` 只接受字面值。

环境是一个完整的具名对象。step 选择它的名称；对象不会被继承、合并或部分覆盖。

### 具名 Agent {#named-agents}

每个 Agent 是一份完整的 Provider 配置：

| 字段               | 是否必填 | 说明                                                                              |
| ------------------ | -------- | --------------------------------------------------------------------------------- |
| `provider`         | 是       | Provider ID。Hub 在无人值守的情况下运行，因此为 `claude`、`codex` 或 `opencode`。 |
| `model`            | 否       | Provider 的模型 ID。                                                              |
| `mode`             | 否       | Paseo 模式 ID。                                                                   |
| `thinkingOptionId` | 否       | Provider 的思考选项。                                                             |
| `options`          | 否       | 可安全序列化为 JSON 的 Provider 原生选项，保留名称和嵌套结构。                    |

具名选择会保留完整的对象，包括结构化的选项。具名 Agent 没有父级、补丁或按 step 的覆盖。

Hub 把 `model`、`mode`、`thinkingOptionId` 和 `options` 传给 Paseo daemon，不会重命名或展平 Provider 字段。保存或部署触发器时，所选的 daemon 会按它当前的 Provider schema 校验这些值，因此它不提供的值会在那时被拒绝，而不是等到第一次运行；Hub 不会转换 Provider 原生选项。见[保存时会对照 daemon 检查 Agent](/docs/hub/triggers#saving-checks-the-agent-against-the-daemon)。

## workflow 文件 {#workflow-files}

`.paseo/workflows/review.yml`：

```yaml
name: review
on: manual.run
max_runtime: 2h
filters:
  from_users: [automation]
inputs:
  repo:
    type: string
    required: true
    choices: [paseo, hub]
steps:
  - id: inspect
    environment: ${{ paseo.inputs.repo }}
    max_runtime: 30m
    idle_timeout: 5m
    agent: codex-safe
    prompt:
      - text: ${{ paseo.prompt }}
```

| 字段          | 是否必填 | 说明                                                    |
| ------------- | -------- | ------------------------------------------------------- |
| `name`        | 是       | workflow 名称，在整个文件包中唯一。                     |
| `on`          | 是       | Provider 事件，例如 `manual.run` 或 `discord.mention`。 |
| `max_runtime` | 是       | 整次运行的硬性时间上限，最多 24h。                      |
| `filters`     | 是       | Provider 资源过滤条件和发送者白名单。                   |
| `inputs`      | 否       | 带类型的调用头部参数。                                  |
| `values`      | 否       | 具名表达式。                                            |
| `steps`       | 是       | 一个或多个有序的内联 step。                             |

### GitHub 事件和过滤条件 {#github-events-and-filters}

新的 GitHub workflow 请使用以下语义化事件名之一：

| `on`                                  | 匹配                                                              |
| ------------------------------------- | ----------------------------------------------------------------- |
| `github.issue_created`                | action 为 `opened` 的 `issues` 投递。                             |
| `github.pull_request_created`         | action 为 `opened` 的 `pull_request` 投递。                       |
| `github.issue_comment_created`        | 在 issue 上、action 为 `created` 的 `issue_comment` 投递。        |
| `github.pull_request_comment_created` | 在 Pull Request 上、action 为 `created` 的 `issue_comment` 投递。 |
| `github.issue_label_added`            | action 为 `labeled` 的 `issues` 投递。                            |
| `github.pull_request_label_added`     | action 为 `labeled` 的 `pull_request` 投递。                      |

已有的配置可以继续使用 `github.issues`、`github.issue_comment`、`github.pull_request_review`、`github.pull_request_review_comment` 和 `github.push`。这些旧版事件保持原有的行为。

`filters` 支持以下 GitHub 字段。对于每个由外部来源触发的 workflow，`from_users` 都必须非空。所有提供的过滤条件以 AND 组合。

| 字段         | 类型                       | 适用于                                                        | 含义                                                       |
| ------------ | -------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| `from_users` | 非空字符串列表             | 所有 GitHub 事件                                              | 允许启动该 workflow 的 GitHub 登录名。                     |
| `repo`       | 非空字符串                 | 所有 GitHub 事件                                              | `owner/name` 形式的仓库。                                  |
| `connection` | 字符串                     | 所有 GitHub 事件                                              | GitHub 连接的 slug。                                       |
| `contains`   | 字符串                     | issue、Pull Request 和评论事件                                | issue 或 Pull Request 的标题加正文中，或评论正文中的子串。 |
| `pattern`    | 字符串                     | issue、Pull Request 和评论事件                                | 同一段文本的开头。                                         |
| `label`      | 非空字符串                 | `github.issue_label_added`、`github.pull_request_label_added` | 本次投递添加的标签。                                       |
| `labels`     | 由非空字符串组成的非空列表 | issue、Pull Request 和评论事件                                | 每个所列标签都必须当前存在于该 issue 或 Pull Request 上。  |

`label` 和 `labels` 匹配 GitHub 标签时不区分大小写。`label` 检查发生变化的那一个标签；`labels` 检查当前完整的标签集合，并要求每一项都存在。例如，`labels: [bug, backend]` 要求同时存在 `bug` 和 `backend`。

`label` 只能与添加标签的事件一起使用，在其他事件上永远不会匹配。使用 `labels` 来要求条目所处的状态，包括由评论启动 workflow 的情况。

完整的分拣、Pull Request 审查和 ready-for-agent workflow，见 [GitHub 触发器](/docs/hub/triggers/github)。

### 输入和值 {#inputs-and-values}

输入的类型为 `type: string | number | boolean`，另有可选的 `required`、`default` 和 `choices`。`required` 和 `default` 不能同时使用。当某个输入可以选择权限相关的对象（例如环境或具名 Agent）时，必须提供有限的 `choices`。

值用于绑定表达式：

```yaml
values:
  selected_environment: ${{ steps.classify.outputs.environment }}
  selected_agent: ${{ steps.classify.outputs.agent }}
```

表达式可以读取已声明的 `paseo.inputs`、之前的 `steps.<id>.outputs` 以及 `values`。语法支持路径、JSON 字面量、括号、`!`、`==`、`!=`、`&&`、`||` 和 `??`。

用于选择环境或动态具名 Agent 的表达式，在激活时必须具有一个有限的、可能的字符串结果集合。每个结果都必须是一个已配置资源的名称。运行时的选择从不会退回到其他环境或 Agent。

### step {#steps}

| 字段              | 是否必填 | 说明                                                                                     |
| ----------------- | -------- | ---------------------------------------------------------------------------------------- |
| `id`              | 是       | 在 workflow 内唯一。                                                                     |
| `environment`     | 是       | 字面的环境名称，或解析为某个环境名称的有限表达式。                                       |
| `max_runtime`     | 是       | step 的硬性时间上限。                                                                    |
| `idle_timeout`    | 是       | 空闲时间上限，不得超过 `max_runtime`。                                                   |
| `startup_timeout` | 否       | step 启动的等待预算。默认值和限制见[启动超时](/docs/hub/configuration#startup-timeout)。 |
| `agent`           | 是       | 具名 Agent、选择具名 Agent 的有限表达式，或一份完整的静态内联 Agent。                    |
| `prompt`          | 是       | 有序的 `text` 和 `include` 块。                                                          |
| `if`              | 否       | 决定该 step 是否运行的表达式。                                                           |
| `env`             | 否       | 来自连接值的环境变量。                                                                   |
| `output.schema`   | 否       | 结构化 step 输出的 JSON Schema。                                                         |
| `allow_outputs`   | 否       | Provider 输出能力，可带 `max` 和 `required`。                                            |
| `auto_archive`    | 否       | step 结束后归档该 Agent。                                                                |
| `github`          | 否       | 该 step 的显式 GitHub 权限。                                                             |

内联 Agent 是静态且完整的：

```yaml
agent:
  provider: codex
  model: gpt-5.5
  options:
    approval_policy: never
    sandbox_mode: read-only
```

表达式形式的 `agent` 用于选择具名 Agent。内联对象中的动态 Provider 字段会被拒绝。

### 提示词语义 {#prompt-semantics}

```yaml
prompt:
  - include: partials/review.md
  - text: |
      <user-prompt>
      ${{ paseo.prompt }}
      </user-prompt>
```

`${{ paseo.prompt }}` 是去掉 Provider 标记和已声明的开头 `key=value` 输入之后的规范化请求。它不会被改写，也不会附加事件上下文。

`${{ paseo.context }}` 让该 step 选择加入 Provider 上下文的具体化，并在提示词中把结果渲染为 JSON。它只能用在提示词文本中。除非 workflow 编写了这个表达式，否则 Hub 不会注入它。

include 相对于 `.paseo/workflows/` 解析，因此共享片段使用 `partials/<name>.md`。缺失的文件、绝对路径或越界路径、符号链接、内容不一致以及位于片段目录树之外的文件都会被拒绝。

### 输出能力 {#output-capabilities}

权限保留在使用它的 step 上：

```yaml
allow_outputs:
  - type: discord.reply
    max: 1
    required: true
```

Slack workflow 使用 `slack.reply`；Discord workflow 使用 `discord.reply`。这项声明授予 `hub.reply`，提示词必须告诉 Agent 调用它。GitHub 没有回复输出；请使用显式的 [`github` 块](/docs/hub/github)。

每个 step 都会获得 `hub.finish_execution`。提示词必须告诉 Agent 何时调用它；Hub 不会追加完成或回复的指示。如果存在 `output.schema`，`hub.finish_execution` 需要一个与该 schema 匹配的 `output` 值。如果某个 `allow_outputs` 条目为 `required: true`，Agent 必须在完成之前发出该输出。`max` 默认为 `1`。

## 迁移单体文件 {#migrating-a-monolithic-file}

把 `environments` 保留在 `hub.yml` 中，把环境列表转换为具名映射，并把原先的每个触发器移到它自己的 `.paseo/workflows/<name>.yml` 文件中。把共享的提示词文件移到 `.paseo/workflows/partials/`。在 `agents` 下定义完整的具名 Agent 配置，并用有限的具名 Agent 选择替换动态的 Provider 字段。

Hub 不读取 TOML 或单体的 `triggers` 部分，CLI 也不会改写这两种格式。

完整的路由示例见 [workflow](/docs/hub/workflows)。

## Agent 延续 {#agent-continuation}

自包含的控制台触发器文档接受 `run.continuation`：

| 值                                                       | 行为                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `{mode: conversation}`                                   | 默认值。为事件所属的对话复用项目中的 Agent；事件没有对话时创建新的 Agent。 |
| `{mode: key, key: "support-${{ paseo.inputs.ticket }}"}` | 为求值得到的自定义键复用项目中的 Agent。                                   |
| `{mode: new}`                                            | 每次到达都创建新的 Agent。                                                 |

键使用现有的表达式语法，必须解析为长度不超过 512 个字符的非空字符串。自定义键和 Provider 的对话标识位于不同的命名空间。不同项目中的相同键不会共享 Agent。

已有的会话会保留它的 daemon、Agent 配置、目标、环境和工具契约。为同一个键修改这些设置会失败并给出说明；请选择另一个键或 **New agent**。提示词和输出目标属于每次到达，可以变化。worktree 分支在会话首次创建时选定，并在之后的到达中复用。

后续消息会引导正在运行的 Agent，但不会延长它的运行截止时间或凭据有效期。当 `run.env` 中有 `run.github` 授权或连接令牌时，后续消息共享正在运行的 Agent 的凭据。所有请求都完成后，Hub 会撤销租用的令牌；下一次到达会用新的凭据启动新的 Agent。没有临时凭据的 Agent 在完成后可以被复用。

### 升级 {#upgrading}

在启用新版 Hub 之前，请先升级已连接的 Paseo daemon。Hub 需要 daemon 的常规 Agent RPC 和请求回执能力；较旧的主机会产生一个可操作的发起错误。

Hub 的数据库迁移会添加会话以及可为空的执行关联。已有的执行会保留它们已保存的启动契约和执行专属的 MCP 端点，直到完成。已有自包含触发器文档的新到达使用对话默认值。历史上的 Agent 不会被回填到会话中。

旧版的多 step workflow 文件包保持原有行为。把它转换为自包含触发器时，会显式写入 `mode: new`；准备好复用 Agent 时，在编辑器中修改它。
