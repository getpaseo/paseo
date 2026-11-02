---
title: Slack 触发器
description: 在一个 workflow 文件中配置 Slack 提及与子区回复。
nav: Slack
---

# Slack 触发器 {#slack-triggers}

当机器人在它所在的频道中被提及时，`slack.mention` 会触发。私信、斜杠命令和交互组件不会产生这个触发器。

`.paseo/workflows/slack-help.yml`：

```yaml
name: slack-help
on: slack.mention
max_runtime: 1h
filters:
  workspace: T01234567
  channels: [C01234567]
  from_users: [U01234567]
steps:
  - id: answer
    environment: dev
    max_runtime: 30m
    idle_timeout: 5m
    agent: codex
    prompt:
      - text: |
          Answer with hub.reply, then call hub.finish_execution.
          ${{ paseo.prompt }}
    allow_outputs:
      - { type: slack.reply, max: 1, required: true }
```

Slack 过滤器使用 ID，而不是显示名称或 Hub 连接的 slug。`from_users` 匹配消息作者，`workspace` 匹配团队，`channels` 匹配频道。`pattern` 是提及之后必须出现的前缀；`contains` 是它的旧别名，前缀行为相同。所有过滤器都必须通过。

回复会发布在触发它的子区中。根消息会开启一个子区；子区中的消息则留在原子区。`slack.reply` 授予 `hub.reply`，但不会在提示词中添加回复说明。

提及之后紧跟的是已声明的输入：

```text
@Paseo repo=project agent=claude investigate the failed sync
```

Hub 会读取连续的已声明头部，并把剩余部分作为 `${{ paseo.prompt }}` 提供。参见 [Workflow](/docs/hub/workflows)。

## 查找 Slack ID {#find-your-slack-ids}

| 过滤器       | 在哪里复制                                                                 |
| ------------ | -------------------------------------------------------------------------- |
| `workspace`  | 在浏览器中打开 Slack。团队 ID 是 URL 中 `T…` 开头的那一段。                |
| `from_users` | 你的头像 → **Profile** → **⋮** → **Copy member ID**。成员 ID 以 `U` 开头。 |
| `channels`   | 频道名称 → **About**。频道 ID 位于面板底部，以 `C` 开头。                  |

[引导式设置](/docs/hub/quickstart)会根据你连接的 Slack 应用填好 `workspace`，并询问你的成员 ID，因此生成的起步配置已经包含这两项。
