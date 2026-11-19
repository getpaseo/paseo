---
title: Antigravity
description: 为 Paseo 安装和配置 Antigravity。
nav: Antigravity
---

# Antigravity {#antigravity}

使用你已安装的 `agy` CLI 和登录状态，在 Paseo 中运行 Antigravity。此集成未经 Google 认可。

## 开始使用 {#getting-started}

在 daemon 主机上安装 Antigravity CLI（`agy`），然后运行一次 `agy` 登录。在 Paseo 中选择 **Antigravity**。该 Provider 随 Paseo 一起提供，无需另外安装插件。

如果 `agy` 不在 daemon 的 PATH 中，请在 `~/.paseo/config.json` 中覆盖它的命令。使用 `env` 设置 Provider 专用的环境变量：

```json
{
  "agents": {
    "providers": {
      "antigravity": {
        "command": ["/absolute/path/to/agy"],
        "env": { "EXAMPLE_VARIABLE": "value" }
      }
    }
  }
}
```

命令和环境变量覆盖见[自定义 Provider](/docs/custom-providers)。

## 权限 {#permissions}

Paseo 通过 `agy acp --stdio` 驱动 Antigravity，并提供三种权限模式：**Default**（执行 shell 命令或编辑文件前询问）、**Accept edits**（自动批准文件读写与编辑，执行 shell 命令前询问）以及 **Full access**（自动批准所有工具调用）。交互式 `ask_question` 提问会以提问卡片的形式在 Paseo 中展示。

轮次中途引导功能不可用。配置的 MCP 服务器和系统提示词会转发给 ACP 会话，附加的图片会以文件引用的形式传给 Agent 读取。此外，Paseo 还会在用量面板中展示 Antigravity 账号配额窗口与 AI Credits 余额，将原生子代理实时同步到子代理面板，并在后台命令、定时任务或子代理执行完成时自动唤醒会话。
