---
title: Hub 触发器
description: Hub 如何把入站事件匹配到触发器：事件、过滤条件，以及把关每次执行的白名单。
nav: 触发器
---

# 触发器 {#triggers}

触发器说明哪个 Provider 事件可以启动一个 workflow。[Hub workflow](/docs/hub/workflows) 页面介绍匹配之后运行的 step、输入、路由、提示词和截止时间。

`.paseo/workflows/github-issue.yml`：

```yaml
name: triage-issue
on: github.issue_created
filters:
  repo: acme/api
  from_users: [alice]
max_runtime: 2h
steps:
  - id: work
    environment: dev
    max_runtime: 90m
    idle_timeout: 10m
    agent: codex
    prompt:
      - text: Call hub.finish_execution when the step is complete.
      - text: ${{ paseo.prompt }}
```

逐字段的说明见[配置参考](/docs/hub/configuration/hub-yml)。

## 在 Hub 中选择 Agent {#choose-the-agent-in-hub}

在 Hub 控制台中创建或编辑触发器时，先选择 daemon 并输入它的工作目录。Hub 不会预填目录：它是那台机器上的路径，必须存在，而且只有你知道 Agent 应该在哪个仓库中工作。随后 Hub 会向该 daemon 查询可用的 Provider、模型、执行模式和思考选项。建议的模型和模式是该 daemon 的默认值。

只有被授予 `hub.execute` 的 daemon 才会作为目标出现，Provider 也只提供 Claude、Codex 和 OpenCode。Hub 在每次运行时都会预先批准它自己的工具，因为没有人在键盘前批准它们，而只有这些 Provider 的 daemon 契约接受这种做法。

修改 daemon 或工作目录会重新加载这些选项。如果已有的触发器指定的模型、模式或思考选项不再由 daemon 报告，Hub 会把该值标记为不可用，但不会替换它。你可以保留原先编写的值、选择当前可用的值，或切换到 YAML 编辑。

如果 daemon 离线或需要更新的 Paseo 版本，Agent 选择器会显示错误和重试操作。触发器的其余部分及其 YAML 仍然可以编辑。

## 保存时会对照 daemon 检查 Agent {#saving-checks-the-agent-against-the-daemon}

保存触发器时，Hub 会请目标 daemon 校验它将要启动的 Agent：Provider、模型、模式、思考选项、Provider 原生选项，以及某个选择可以选中的每个具名 Agent。daemon 不提供的值会在保存时被拒绝，并指出对应字段，而不是等到第一次运行才失败。

```text
run.agent.mode: Mode 'default' is not available for provider 'opencode'
```

这项检查需要 daemon 已连接。daemon 离线时，新的触发器，以及对 daemon、工作目录或 Agent 的修改都无法保存；拒绝信息会指出是哪个 daemon。编辑已有触发器的提示词、过滤条件或限制则无论如何都能保存。

无论在哪里编写触发器，都会运行相同的检查：控制台表单、它的 YAML 模式、`POST /api/v1/triggers/install`、`paseo hub init` 和 `paseo hub deploy`。

## 继续同一个 Agent {#continue-the-same-agent}

控制台中的触发器默认为 **Same conversation**。同一个 Slack 或 Discord 线程中的消息、同一个 GitHub issue 或 Pull Request 上的事件，以及同一个 Linear issue 上的事件，都会在该项目中继续现有的 Agent。没有对话的事件会启动一个新的 Agent。

如果 Agent 正忙，新的提示词会引导它当前的工作。每次到达都保留各自的输出限制和完成状态。如果可复用的工作区已被归档，Hub 会在发送提示词之前请 Paseo 恢复它。

选择 **Custom key** 可以按某个输入对到达的事件分组，选择 **New agent** 则让它们彼此独立。自包含的触发器文档也可以表达同样的选择：

```yaml
name: support
on:
  slack.mention:
    filters:
      from_users: [U01234567]
run:
  target:
    daemon: laptop
    cwd: /Users/you/code/support
  agent:
    provider: codex
  continuation:
    mode: conversation
  max_runtime: 30m
  idle_timeout: 5m
  prompt: Handle this request and call finish_execution when complete.
```

[延续参考](/docs/hub/configuration/hub-yml#agent-continuation)介绍了键和 Agent 复用。运行详情会显示每次到达是创建、继续还是恢复了 Agent。

Hub 在每段提示词中都包含一个 `executionId`。使用持续的 Agent 时，请把这个 ID 传给 `reply` 和 `finish_execution`。这些工具作用于该次到达的目标和契约；旧的或无关的执行 ID 会被拒绝。

## 事件 {#events}

| `on`                                   | 触发时机                        |
| -------------------------------------- | ------------------------------- |
| `github.issue_created`                 | 有 issue 被创建。               |
| `github.pull_request_created`          | 有 Pull Request 被创建。        |
| `github.pull_request_ready_for_review` | 草稿 PR 被标记为可审查。        |
| `github.issue_comment_created`         | issue 上新增了评论。            |
| `github.pull_request_comment_created`  | Pull Request 上新增了对话评论。 |
| `github.issue_label_added`             | issue 被添加了标签。            |
| `github.pull_request_label_added`      | Pull Request 被添加了标签。     |
| `slack.mention`                        | 机器人在频道中被提及。          |
| `discord.mention`                      | 机器人在服务器中被提及。        |
| `manual.run`                           | 通过 API 发起了一次运行。       |

新的 GitHub workflow 应使用语义化事件。五个旧版事件仍然兼容：`github.issues`、`github.issue_comment`、`github.pull_request_review`、`github.pull_request_review_comment` 和 `github.push`。完整的 workflow 以及何时使用哪个事件，见 [GitHub 触发器](/docs/hub/triggers/github)。

每个 Provider 的页面记录了它的事件及其提供的数据：

- [GitHub 触发器](/docs/hub/triggers/github)
- [Slack 触发器](/docs/hub/triggers/slack)
- [Discord 触发器](/docs/hub/triggers/discord)

## 过滤条件 {#filters}

`filters` 是必填的，而且 `from_users` 必须存在且非空。缺少它的触发器会在校验时被拒绝。

这个白名单防止陌生人在公开 issue 上的一条评论就在你的机器上启动 Agent。它没有默认值，因为安全的默认值因仓库而异。

白名单只是一层防御。它不能让一个被盗用的、已获准的账号变得可信，也不能让提示词注入变得无害。为外部触发器选择 daemon、工作目录、Provider 策略和输出之前，请先阅读 [Hub 安全](/docs/hub/security)。

| 过滤条件     | 适用于              | 匹配内容                                                      |
| ------------ | ------------------- | ------------------------------------------------------------- |
| `from_users` | 全部                | GitHub：登录名。Slack 和 Discord：**用户 ID**，而不是显示名称 |
| `repo`       | GitHub              | `owner/name`                                                  |
| `workspace`  | Slack               | Team ID，`T01234567`                                          |
| `guild`      | Discord             | 服务器 ID                                                     |
| `channels`   | Slack、Discord      | 频道 ID                                                       |
| `contains`   | 全部                | GitHub 子串；Slack 和 Discord 调用前缀                        |
| `pattern`    | 全部                | 调用前缀                                                      |
| `connection` | 全部                | 组织有多个连接时的连接 slug                                   |
| `label`      | GitHub 添加标签事件 | 本次投递添加的标签，不区分大小写                              |
| `labels`     | GitHub              | issue 或 Pull Request 当前带有的每个所列标签，不区分大小写    |

所有条件都必须通过。没有 `any` 模式。

## 事件来自哪个连接 {#which-connection-an-event-comes-from}

`repo`、`workspace` 和 `guild` 在配置激活时会被解析为不可变的 ID，并确定拥有它们的连接。如果指定的资源在组织中没有对应的连接，激活就会失败，因此你会在推送时发现问题，而不是等到有人评论时。

省略资源过滤条件时，触发器会监听组织中该 Provider 的所有连接。要把它固定到某一个连接：

```yaml
filters:
  connection: acme-github
  from_users: [alice]
```

激活时编译了什么，见 [Hub 的工作原理](/docs/hub/concepts)。

## 两个触发器同时匹配时 {#when-two-triggers-match}

两个都会运行。触发器没有顺序，也不会相互遮蔽，无论是在同一个配置中还是跨项目。

## 回复 {#replying}

在需要回复的 step 上设置 `allow_outputs`。回复能力是 `slack.reply` 和 `discord.reply`。

- 当 step 需要不止一次更新时，设置 `max`。
- 当 step 必须至少发出一次回复才能完成时，设置 `required: true`。必需的类型必须已注册，并且在该执行上下文中可用。

GitHub 没有回复能力；带有 [`github` 块](/docs/hub/github)的 step 会改为通过 `gh` 发表评论。契约见[输出能力参考](/docs/hub/configuration/hub-yml#output-capabilities)。

这项声明授予 `hub.reply` 工具；提示词必须告诉 Agent 调用它。见[告诉 Agent 调用哪个工具](/docs/hub/workflows#tell-the-agent-which-tool-to-call)。
