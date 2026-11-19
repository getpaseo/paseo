---
title: Antigravity
description: 为 Paseo 安装和配置 Antigravity。
nav: Antigravity
---

# Antigravity {#antigravity}

使用你已安装的 `agy` CLI 和登录状态，在 Paseo 中运行 Antigravity。此集成未经 Google 认可。

## 开始使用 {#getting-started}

在 daemon 主机上安装 Antigravity CLI（`agy`）1.5.0 或更高版本，然后运行一次 `agy` 登录。在 Paseo 中选择 **Antigravity**。该 Provider 随 Paseo 一起提供，无需另外安装插件。

如果 `agy` 不在 daemon 的 PATH 中，请在 `~/.paseo/config.json` 中覆盖它的命令。使用 `env` 设置 Provider 专用的环境变量：

```json
{
  "agents": {
    "providers": {
      "antigravity": {
        "command": ["/absolute/path/to/agy", "acp", "--disable-telemetry"],
        "env": { "EXAMPLE_VARIABLE": "value" }
      }
    }
  }
}
```

如果你已覆盖命令，请在命令参数中加入 `acp`。命令和环境变量覆盖见[自定义 Provider](/docs/custom-providers)。

## 权限 {#permissions}

Paseo 连接到 `agy acp`，并显示 CLI 提供的权限模式。在 **Default** 模式下，如果 Antigravity 的权限策略要求批准编辑或命令，Paseo 会显示审批请求。在 **Accept edits** 模式下，Antigravity 会自动批准工作区内的编辑，仍会询问是否批准需要审批的命令。**Plan** 模式让 Antigravity 先规划，再执行。

以前以 **Full access** 模式保存的 Paseo 聊天会以 **Default** 模式重新打开。Paseo 不提供 Antigravity 的无人值守模式。如果计划任务遇到审批请求，本次运行就会失败。

## 会话和工具 {#sessions-and-tools}

Paseo 可以导入 CLI 会话，并在重新打开聊天时恢复对话历史。Antigravity 通过 ACP 提供斜杠命令、接收图片附件，也会使用为 Agent 配置的 MCP 服务器。

你可以在当前轮次结束后发送后续消息，也可以中断当前轮次来改变方向。
