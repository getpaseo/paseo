---
title: Slack 触发器
description: 根据 Slack 频道和讨论串中的提及启动 Hub Agent，并在讨论串中回复。
nav: Slack
---

# Slack 触发器 {#slack-triggers}

当有人在机器人所在的 Slack 频道或讨论串中提及机器人时，`slack.mention` 会触发。私信、斜杠命令和交互组件不会触发此事件。

请先在 **Integrations** 下连接 Slack 工作区（自托管 Hub 请先配置 [Slack 应用](/docs/hub/self-hosting/slack-app)），并将机器人邀请到它监听的频道。

`.paseo/triggers/slack-help.yml`：

```yaml
name: slack-help
on:
  slack.mention:
    connection: acme-slack
    filters:
      workspace: T01234567
      channels: [C01234567]
      from_users: [U01234567]
run:
  target:
    daemon: devbox
    cwd: /workspace/project
  agent:
    provider: codex
    mode: full-access
  continuation:
    mode: conversation
  max_runtime: 30m
  idle_timeout: 5m
  prompt: |
    Answer the request using reply, then call finish_execution.

    <user-prompt>
    ${{ paseo.prompt }}
    </user-prompt>
  outputs:
    slack.reply:
      max: 1
      required: true
```

## 过滤条件与提示词文本 {#filters-and-prompt-text}

Slack 过滤条件使用 ID，而不是显示名称或连接 slug。所有过滤条件按逻辑与组合：

- `from_users` 为必填项，匹配发送者的 Slack 成员 ID。
- `workspace` 匹配 Slack Team ID，`channels` 限制可触发运行的频道。
- `pattern` 要求提及之后紧跟指定前缀（`contains` 是其旧别名，前缀行为相同）。

`${{ paseo.prompt }}` 包含收到的完整消息文本。如果你在触发器上声明了 `inputs`，Hub 会将提及之后紧跟的 `key=value` 头部解析到 `${{ paseo.inputs }}`：

```text
@Paseo repo=project investigate the failed sync
```

在 `run.prompt` 中包含 `${{ paseo.context }}`，即可以 JSON 形式传入 Slack 讨论串历史和限定在本次执行范围内的附件描述符。

## 回复与会话延续 {#replies-and-continuation}

Hub 会在触发运行的 Slack 讨论串中发布回复。频道根消息会开启一个讨论串，讨论串内的提及则继续留在原讨论串中。同一讨论串中的后续提及默认会继续同一个 Agent。

Slack 触发器会自动授予 `reply` 工具（`slack.reply`）。如需限制 `max` 次数或设置 `required: true`，请声明 `run.outputs.slack.reply`。当 Hub 运行在 HTTPS 下时，回复会附带 **Open in Paseo** 链接。

如需在定时任务、webhook 或其他触发器中读取或发送到 Slack 频道，请使用[集成工具](/docs/hub/tools)。如需赋予 Agent 仓库访问权限，请添加 [`run.github` 块](/docs/hub/github)。

## 查找 Slack ID {#find-your-slack-ids}

| 过滤条件     | 复制位置                                                                 |
| ------------ | ------------------------------------------------------------------------ |
| `workspace`  | 在浏览器中打开 Slack。Team ID 是 URL 中的 `T...` 片段。                  |
| `from_users` | 点击头像，选择 **Profile** → **⋮** → **Copy member ID**（以 `U` 开头）。 |
| `channels`   | 点击频道名称，选择 **About**。频道 ID 位于面板底部（以 `C` 开头）。      |

`paseo hub init` 会自动读取已连接的 Slack 工作区，只询问你的成员 ID。
