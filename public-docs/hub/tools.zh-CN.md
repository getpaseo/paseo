---
title: 集成工具
description: 通过 Hub MCP 为任意 Hub 触发器授予受控的 Slack 和 Discord 读取与发送工具。
nav: 集成工具
---

# 集成工具 {#integration-tools}

任意 Hub 触发器都可以通过 Hub MCP 服务器为 Agent 授予受控的 Slack 和 Discord 工具。每日定时任务可以向 Slack 发送 CI 摘要，webhook 处理器可以先读取最近的 Discord 上下文再发布更新，GitHub 触发器也可以通知 Slack 频道，无需在 daemon 上安装外部 CLI 或存放聊天令牌。

Hub 将 Provider 令牌保留在服务端，并在每次工具调用时校验连接、操作类型和频道白名单。

## 在控制台或 YAML 中配置 {#configure-in-the-dashboard-or-yaml}

1. 在 Hub 触发器编辑器中打开 **Integration access**。
2. 选择 **Add integration**，然后选择 **Slack** 或 **Discord**。
3. 在 **Connection** 中选择集成。
4. 在 **Channel IDs** 中输入允许访问的频道 ID。
5. 选择 **Read messages**、**Post messages** 或两者。

在 `.paseo/triggers/*.yml` 中添加 `run.tools`：

```yaml
name: nightly-digest
on:
  schedule.tick:
    recurrence:
      start: "2026-09-09T08:00:00"
      rule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"
      timezone: America/New_York
run:
  target:
    daemon: devbox
    cwd: /workspace/project
  agent:
    provider: codex
    mode: full-access
  continuation:
    mode: new
  tools:
    slack:
      connection: engineering-slack
      actions: [post]
      channels: [C012AB3CD]
    discord:
      connection: community-discord
      actions: [read, post]
      channels: ["123456789012345678"]
  prompt: |
    Scan recent Discord messages with discord_latest, summarize open bugs,
    and post the digest to Slack channel C012AB3CD with slack_post.
    Call finish_execution when done.
```

## 授权字段 {#grant-fields}

| 字段         | 必填 | 说明                                                                              |
| ------------ | ---- | --------------------------------------------------------------------------------- |
| `connection` | 是   | 来自 **Integrations** 的集成 slug，例如 `engineering-slack`。                     |
| `actions`    | 是   | 非空列表，包含 `read`、`post` 或两者。                                            |
| `channels`   | 是   | 显式白名单，包含 1 到 50 个频道 ID。Discord snowflake ID 请用引号括起作为字符串。 |

查看[查找 Slack ID](/docs/hub/triggers/slack#find-your-slack-ids)和[查找 Discord ID](/docs/hub/triggers/discord#find-your-discord-ids)以复制频道 ID。

## 可用的 Hub MCP 工具 {#available-hub-mcp-tools}

| 权限         | 向 Agent 开放的工具                                                                                                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack read   | `slack_list_channels` 列出已授权的频道 ID。`slack_read` 读取频道或讨论串消息（支持 `limit`、`thread_ts` 和来自 `nextCursor` 的 `cursor`）。                                                                     |
| Slack post   | `slack_post` 向已授权频道发消息，或通过起始消息的 `thread_ts` 在讨论串中回复。                                                                                                                                  |
| Discord read | `discord_list_channels` 列出已授权的频道和论坛。`discord_read` 读取频道、论坛、讨论串或精确消息 URL（使用 `nextBefore` 传入 `before`）。`discord_latest` 扫描已授权频道的近期消息，包括活跃和近期归档的讨论串。 |
| Discord post | `discord_post` 向已授权频道发消息、在讨论串中回复，或在频道消息上开启上下文讨论串。                                                                                                                             |

## 校验与行为 {#enforcement-and-behavior}

- Hub 会在每次工具调用时对照声明的 `connection`、`actions` 和 `channels` 进行校验。只有在讨论串父频道位于 `channels` 白名单内时，才允许访问对应的 Discord 讨论串和论坛帖子。
- 当 Hub 配置了 HTTPS 地址且记录了 daemon Agent 时，拥有 `post` 权限的 Agent 会在请求上下文中收到该次运行的 **Open in Paseo** URL，方便摘要和报告直接链接到会话。
- 由于工具契约绑定在活动会话上，修改持续运行的触发器中的 `run.tools` 时，下一次运行需要使用 **New agent**（`continuation: { mode: new }`）或新的延续键。
- 如果你的 `run.tools` 块使用了 YAML 锚点或别名，请在 YAML 视图中编辑触发器，以便 Hub 完整保留这些引用。
