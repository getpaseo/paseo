---
title: Discord 触发器
description: 在一个 workflow 文件中配置 Discord 提及与回复。
nav: Discord
---

# Discord 触发器 {#discord-triggers}

当机器人或受管角色在服务器频道或子区中被提及时，`discord.mention` 会触发。

`.paseo/workflows/discord-help.yml`：

```yaml
name: discord-help
on: discord.mention
max_runtime: 1h
filters:
  guild: "123456789012345678"
  channels: ["234567890123456789"]
  from_users: ["345678901234567890"]
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
      - { type: discord.reply, max: 1, required: true }
```

Discord 过滤器使用 ID，而不是服务器名称、显示名称或 Hub 连接的 slug。`from_users` 匹配消息作者；`guild` 和 `channels` 限定提及出现的位置。`pattern` 是提及之后必须出现的前缀；`contains` 是它的旧别名，前缀行为相同。所有过滤器都必须通过。

回复会发布在触发它的子区或频道中。`discord.reply` 授予 `hub.reply`，但不会改写提示词。Discord 触发器不授予任何 GitHub 凭据；请在需要的 step 中添加 [`github` 块](/docs/hub/github)。

提及之后紧跟的是已声明的输入。Hub 把剩余文本作为 `${{ paseo.prompt }}` 提供。参见 [Workflow](/docs/hub/workflows)。

## 查找 Discord ID {#find-your-discord-ids}

打开 **Settings → Advanced → Developer Mode**，然后右键选择 **Copy Server ID** 获取 `guild`，**Copy Channel ID** 获取 `channels`，**Copy User ID** 获取 `from_users`。三者都是数字 snowflake；请加上引号，让 YAML 把它们当作字符串。

[引导式设置](/docs/hub/quickstart)会根据你连接的 Discord 应用填好 `guild`，并询问你的用户 ID。
