---
title: Discord 触发器
description: 根据 Discord 提及启动 Hub Agent，并在频道或讨论串中回复。
nav: Discord
---

# Discord 触发器 {#discord-triggers}

当有人在 Discord 服务器频道或讨论串中提及机器人或其托管角色时，`discord.mention` 会触发。

请先在 **Integrations** 下连接 Discord 服务器（自托管 Hub 请先配置 [Discord 应用](/docs/hub/self-hosting/discord-app)）。

`.paseo/triggers/discord-help.yml`：

```yaml
name: discord-help
on:
  discord.mention:
    connection: acme-discord
    filters:
      guild: "123456789012345678"
      channels: ["234567890123456789"]
      from_users: ["345678901234567890"]
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
    discord.reply:
      max: 1
      required: true
```

## 过滤条件与提示词文本 {#filters-and-prompt-text}

Discord 过滤条件使用数字 snowflake ID，而不是服务器名称、显示名称或连接 slug。请为每个 snowflake ID 加上引号，让 YAML 将其保留为字符串。

`from_users` 为必填项，匹配发送者，`guild` 和 `channels` 限制提及出现的位置。`pattern` 要求提及之后紧跟指定前缀（`contains` 是其旧别名，前缀行为相同）。所有过滤条件按逻辑与组合。

`${{ paseo.prompt }}` 包含收到的完整消息文本。如果你声明了 `inputs`，Hub 会将提及之后紧跟的 `key=value` 头部解析到 `${{ paseo.inputs }}`。在 `run.prompt` 中包含 `${{ paseo.context }}`，即可以 JSON 形式传入被引用的消息、讨论串历史和附件描述符。

## 回复与会话延续 {#replies-and-continuation}

Hub 会在触发运行的 Discord 频道或讨论串中发布回复。同一讨论串中的后续提及默认会继续同一个 Agent。

Discord 触发器会自动授予 `reply` 工具（`discord.reply`）。声明 `run.outputs.discord.reply` 可以设置 `max` 或 `required: true`。当 Hub 运行在 HTTPS 下时，回复会附带 **Open in Paseo** 链接。

如需在定时任务、webhook 或其他触发器中读取或发送到 Discord 频道和论坛，请使用[集成工具](/docs/hub/tools)。如需赋予 Agent 仓库访问权限，请添加 [`run.github` 块](/docs/hub/github)。

## 查找 Discord ID {#find-your-discord-ids}

在 Discord 中开启 **Settings → Advanced → Developer Mode**。右键点击服务器并选择 **Copy Server ID** 获取 `guild`，右键点击频道并选择 **Copy Channel ID** 获取 `channels`，右键点击用户并选择 **Copy User ID** 获取 `from_users`。

`paseo hub init` 会自动选择你已连接的 Discord 服务器，并询问你的用户 ID。
