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

**Full access** 是默认模式。如果工具请求只提供一个 **Allow once** 操作，Paseo 会自动批准。Antigravity 仍会执行自己的工具策略。以前以 **Full access** 模式保存的聊天会保留该模式，计划任务也可以使用该模式，无需人为逐次审批。

切换到 **Full access** 或从该模式切换到其他模式前，请先完成或停止当前轮次。

## 会话和工具 {#sessions-and-tools}

Paseo 可以导入 CLI 会话，并在重新打开聊天时恢复对话历史。Antigravity 通过 ACP 提供斜杠命令、接收图片附件，也会使用为 Agent 配置的 MCP 服务器。

你可以在当前轮次结束后发送后续消息，也可以中断当前轮次来改变方向。
