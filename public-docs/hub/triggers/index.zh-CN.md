---
title: Hub 触发器
description: 将事件、定时任务和 webhook 连接到在你的 Paseo daemon 上运行的 Agent。
nav: 触发器
---

# 触发器 {#triggers}

触发器定义了什么条件会在你的 daemon 上启动 Agent、允许谁触发、运行哪个 Agent，以及它可以使用哪些工具或回复能力。

你可以在 Hub 控制台的 **Triggers** 页面使用表单或 YAML 视图编写触发器，也可以将其保存在 `.paseo/triggers/*.yml` 中，通过 `paseo hub deploy` 部署。

`.paseo/triggers/github-issue.yml`：

```yaml
name: triage-issue
on:
  github.issue_created:
    connection: acme-github
    filters:
      repo: acme/api
      from_users: [alice]
run:
  target:
    daemon: devbox
    cwd: /workspace/api
  agent:
    provider: codex
    mode: full-access
  max_runtime: 90m
  idle_timeout: 10m
  prompt: |
    Triage this issue, reply with your summary using reply, then call finish_execution.
    ${{ paseo.context }}
```

所有支持的字段见[触发器 YAML 参考](/docs/hub/configuration/reference)。

## 在 Hub 中选择 Agent {#choose-the-agent-in-hub}

在 Hub 控制台中创建或编辑触发器时，先选择 daemon 并输入工作目录。Hub 会向该 daemon 查询可用的 Provider、模型、执行模式和思考选项。

只有被授予 `hub.execute` 的 daemon 会作为目标出现。Hub 支持你在 Paseo daemon 上配置的任意 Provider，包括 Claude Code、Codex、OpenCode、Pi，以及自定义或插件 Provider。当 Provider 支持工具预批准时，Hub 会自动预批准自身的 MCP 工具。

修改 daemon 或工作目录会重新加载可用选项。如果已有触发器指定的模型、模式或思考选项不再由 daemon 报告，Hub 会将该值标记为不可用而不会覆盖它。你可以保留原值、改选当前可用值，或直接编辑 YAML。

如果 daemon 离线或需要更新 Paseo 版本，Agent 选择器会显示错误和重试按钮，触发器的其余部分仍可编辑。

## 保存时会对照 daemon 检查 Agent {#saving-checks-the-agent-against-the-daemon}

保存或部署触发器时，Hub 会请目标 daemon 校验 Provider、模型、模式、思考选项、Provider 原生 `options` 以及具名 `choices`。daemon 不提供的值会被立即拒绝并指出具体字段：

```text
run.agent.mode: Mode 'default' is not available for provider 'opencode'
```

创建新触发器或修改触发器的 daemon、工作目录或 Agent 设置时，目标 daemon 必须在线。仅编辑已有触发器的提示词、过滤条件或限制时，即使 daemon 离线也能保存。

控制台表单、YAML 编辑器、`POST /api/v1/triggers/install`、`paseo hub init` 和 `paseo hub deploy` 都会执行相同的校验。

## 继续同一个 Agent {#continue-the-same-agent}

触发器默认为 **Same conversation**（`continuation: { mode: conversation }`）。同一个 Slack 或 Discord 讨论串中的后续消息、同一个 GitHub issue 或 Pull Request 上的事件，以及同一个 Linear issue 上的事件，都会继续现有的 Agent 会话，而不是启动新的 Agent。没有对话上下文的事件会启动一个新的 Agent。

如果 Agent 正忙，新的提示词会引导它当前的工作。每次到达都保留各自的回复目标、输出限制和完成契约。如果可复用的工作区已被归档，Hub 会在发送后续提示词前先恢复它。

选择 **Custom key**（`{ mode: key, key: "..." }`）可以按输入表达式分组，选择 **New agent**（`{ mode: new }`）则每次都启动全新的 Agent。

```yaml
name: support
on:
  slack.mention:
    connection: acme-slack
    filters:
      from_users: [U01234567]
run:
  target:
    daemon: laptop
    cwd: /Users/you/code/support
  agent:
    provider: codex
    mode: full-access
  continuation:
    mode: conversation
  max_runtime: 30m
  idle_timeout: 5m
  prompt: Handle this request, answer with reply, and call finish_execution when complete.
```

Hub 会在每段提示词中附带 `executionId`。在持续运行的 Agent 上调用 `reply` 和 `finish_execution` 时，需要传入该 `executionId`，确保输出路由到对应的请求。参见[Agent 延续](/docs/hub/configuration/reference#agent-continuation)。

## 事件 {#events}

| `on`                                   | 触发时机                                        |
| -------------------------------------- | ----------------------------------------------- |
| `github.issue_created`                 | 创建了 GitHub issue。                           |
| `github.pull_request_created`          | 创建了 GitHub Pull Request。                    |
| `github.pull_request_ready_for_review` | 草稿 Pull Request 被标记为可审查。              |
| `github.pull_request_synchronized`     | 向打开的 Pull Request 推送了新提交。            |
| `github.issue_comment_created`         | GitHub issue 上发表了评论。                     |
| `github.pull_request_comment_created`  | Pull Request 上发表了对话评论。                 |
| `github.issue_label_added`             | 为 GitHub issue 添加了标签。                    |
| `github.pull_request_label_added`      | 为 Pull Request 添加了标签。                    |
| `linear.comment_created`               | Linear issue 上发表了评论。                     |
| `linear.issue_assigned`                | Linear issue 被分配或重新分配。                 |
| `linear.issue_entered_scope`           | Linear issue 在范围内创建或进入范围。           |
| `slack.mention`                        | 机器人在 Slack 频道或讨论串中被提及。           |
| `discord.mention`                      | 机器人在 Discord 频道或讨论串中被提及。         |
| `schedule.tick`                        | 按你的时区触发周期性日历定时任务。              |
| `webhook.received`                     | 触发器的 webhook 端点收到已认证的 HTTP `POST`。 |
| `manual.run`                           | 通过 Hub API 发起了一次运行。                   |

各触发器来源的详细指南：

- [GitHub 触发器](/docs/hub/triggers/github)
- [Linear 触发器](/docs/hub/triggers/linear)
- [Slack 触发器](/docs/hub/triggers/slack)
- [Discord 触发器](/docs/hub/triggers/discord)
- [定时触发器](/docs/hub/triggers/schedules)
- [入站 webhook](/docs/hub/triggers/webhooks)

## 过滤条件 {#filters}

外部 Provider 触发器必须设置非空的 `from_users` 白名单，但有三个例外：

- `linear.issue_entered_scope` 要求设置 `filters.project`，可以省略 `from_users`。
- `schedule.tick` 使用 `recurrence`，不接受 `connection` 或 `filters`。
- `webhook.received` 通过 Bearer 密钥验证调用方，不接受 `connection` 或 `filters`。

控制台触发器表单默认将 **Audience** 设为 **Everyone**，保存为 `from_users: ["*"]`，允许公开仓库或工作区中的任意用户启动运行。如需限制访问，请在表单中选择 **Specific people**，或在 YAML 的 `from_users` 中显式列出登录名或用户 ID。

白名单不能为 Agent 提供沙箱隔离，也不会清洗不可信文本，授予写权限或放宽受众范围前请先阅读 [Hub 安全](/docs/hub/security)。

| 过滤条件           | 适用于                         | 匹配内容                                                      |
| ------------------ | ------------------------------ | ------------------------------------------------------------- |
| `from_users`       | GitHub、Linear、Slack、Discord | GitHub 登录名，或 Linear、Slack 和 Discord 的用户 ID          |
| `repo`             | GitHub                         | `owner/name` 形式的仓库                                       |
| `workspace`        | Slack                          | 工作区 Team ID（`T01234567`）                                 |
| `guild`            | Discord                        | 服务器 Guild ID（加引号的字符串）                             |
| `channels`         | Slack、Discord                 | 频道 ID                                                       |
| `project`          | Linear                         | Linear 项目 UUID                                              |
| `states`           | Linear                         | Linear 工作流状态 UUID                                        |
| `assignees`        | Linear                         | Linear 负责人用户 UUID                                        |
| `contains`         | GitHub、Linear、Slack、Discord | GitHub 和 Linear 评论中的子串，或 Slack 和 Discord 的调用前缀 |
| `exclude_contains` | GitHub                         | 命中后排除该事件的子串                                        |
| `pattern`          | GitHub、Linear、Slack、Discord | 文本开头或提及之后必须匹配的前缀                              |
| `label`            | GitHub 添加标签事件            | 本次事件添加的标签，不区分大小写                              |
| `labels`           | GitHub、Linear                 | 必须同时具备的每个标签（GitHub 用名称，Linear 用 UUID）       |
| `exclude_labels`   | Linear                         | 带有其中任一标签 UUID 即排除该 issue                          |

所有条件按逻辑与组合，没有 `any` 模式。

## 指定连接 {#pinning-a-connection}

在事件对象上设置 `connection` 可以将触发器限定到某一个组织集成 slug。如果没有设置 `connection` 或资源过滤条件（`repo`、`workspace`、`guild`），触发器会监听组织内该 Provider 的所有集成。

```yaml
on:
  github.issue_comment_created:
    connection: acme-github
    filters:
      from_users: [alice]
```

## 两个触发器同时匹配时 {#when-two-triggers-match}

两个都会运行。触发器彼此独立、没有先后顺序，也不会互相遮蔽。

## 回复与 Open in Paseo 链接 {#replying-and-open-in-paseo-links}

对话类触发器（`github.*`、`linear.*`、`slack.*`、`discord.*`）会自动通过 Hub MCP 服务器授予事件原生的 `reply` 工具，让 Agent 可以向来源 issue、Pull Request 或讨论串发送进度更新和最终答复。

如需限制最大回复次数，或要求在 `finish_execution` 成功前至少回复一次，请声明 `run.outputs`：

```yaml
run:
  outputs:
    slack.reply:
      max: 1
      required: true
```

根据触发器来源使用 `github.reply`、`linear.reply`、`slack.reply` 或 `discord.reply`。提示词必须明确告诉 Agent 调用 `reply` 和 `finish_execution`，因为 Hub 不会改写你的提示词来添加工具说明。参见[输出能力](/docs/hub/configuration/reference#output-capabilities)。

当 Hub 配置了 HTTPS 地址且运行记录了 daemon Agent 时，Hub 会在对话回复中附带 **Open in Paseo** 链接，方便已登录的组织成员在 Paseo 中打开实时会话或在 Hub 中查看运行记录。

如需在任意触发器（包括定时任务、webhook、GitHub 和 Linear）中读取或发送到 Slack 或 Discord 频道，请授予[集成工具](/docs/hub/tools)。
