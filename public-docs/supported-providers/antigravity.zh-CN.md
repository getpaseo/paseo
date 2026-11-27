---
title: Antigravity
description: 通过官方 agy CLI 的 ACP 接口在 Paseo 中运行 Antigravity。
nav: Antigravity
---

# Antigravity {#antigravity}

Paseo 通过你已安装的 `agy` CLI 提供的官方 Agent Client Protocol（`agy acp`）运行 Antigravity。Paseo 使用你现有的登录状态驱动本地 CLI，而不会直接调用 Google 端点。

## 开始使用 {#getting-started}

Antigravity 内置于 Paseo 且默认启用，无需安装插件或额外配置。

1. 在 daemon 主机上安装 1.5.1 或更高版本的 [Antigravity CLI](https://antigravity.google/docs/getting-started?tab=cli)（`agy`）。
2. 在终端中运行 `agy` 并登录。
3. 在 Paseo 中启动 Agent 时选择 **Antigravity**。

如果 `agy` 不在 daemon 的 PATH 中，请使用[命令覆盖](/docs/custom-providers#custom-binary)，并在参数中保留 `acp`。

## 权限 {#permissions}

Paseo 连接到 `agy acp`，并显示 CLI 提供的权限模式。**Full access** 是默认模式。

| 模式         | 效果                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------- |
| Full access  | 如果工具请求只提供一个 **Allow once** 操作，Paseo 会自动批准。Antigravity 仍会执行自己的工具策略。 |
| Default      | 如果 Antigravity 的策略要求批准编辑或命令，Paseo 会显示审批请求。                                  |
| Accept edits | Antigravity 会自动批准工作区内的编辑，仍会询问需要审批的命令。                                     |
| Plan         | Antigravity 先规划，再执行。                                                                       |

切换到 **Full access** 或从该模式切换到其他模式前，请先完成或停止当前轮次。

个人 Google 登录（`oauth-personal`）适用于交互式会话。对于无人值守或定时任务，请配置 API 密钥认证（`GEMINI_API_KEY` 或 `agent-platform`），不要使用个人 OAuth。

## 会话和工具 {#sessions-and-tools}

- Paseo 可以导入 CLI 会话，并在重新打开聊天时恢复对话历史。
- Antigravity 提供斜杠命令和技能、接收图片附件，也会使用为 Agent 配置的 MCP 服务器。
- 你可以在当前轮次结束后发送后续消息，也可以中断当前轮次来改变方向。

升级 Paseo 后，较早的 Hub 触发器可能会提示其 Antigravity 模型不可用。请在 Hub 中打开该触发器，并重新选择模型和思考级别。

## 故障排查 {#troubleshooting}

在 Paseo 中打开 **设置 → Providers → Antigravity** 并选择 **诊断报告**。报告会显示 Paseo 运行的命令、daemon 找到 `agy` 的位置、`agy` 的版本、模型数量，以及 `agy` 是否在 SSH 会话中运行。

### 缺少新模型 {#new-models-are-missing}

Paseo 会在首次启动（或升级 `agy` CLI 后）探测一次 Antigravity 的模型和思考级别，并将目录缓存到磁盘以便在 daemon 重启后复用，不会在后台定时轮询。当你的账号获得新模型时，请打开 **设置 → Providers → Antigravity** 并选择 **刷新**。

### Paseo 显示的模型与 `agy models` 不同 {#paseo-shows-different-models-than-agy-models}

`agy` 在同一台机器上保存两份登录状态。在 SSH 会话中，`agy` 从 token 文件读取登录状态。在 SSH 会话之外，`agy` 从操作系统的密钥环读取登录状态。如果两份登录状态使用不同的 Google 账号，你的终端和 Paseo 会显示不同的模型。[Antigravity CLI issue 1336](https://github.com/google-antigravity/antigravity-cli/issues/1336) 跟踪此行为。

Paseo 使用 daemon 的环境运行 `agy`。从 SSH 会话启动的 daemon 会在 SSH 会话中运行 `agy`。由桌面会话或服务管理器启动的 daemon 会在 SSH 会话之外运行 `agy`。诊断报告中的 `SSH session` 行会显示当前属于哪种情况。

如果该行显示 `SSH session: no`，请在 daemon 主机的终端中执行以下步骤：

1. 列出 Paseo 所用登录状态下的模型：

   ```bash
   env -u SSH_CONNECTION -u SSH_CLIENT -u SSH_TTY agy models
   ```

2. 如果列表与预期不符，请用同一份登录状态启动 `agy`：

   ```bash
   env -u SSH_CONNECTION -u SSH_CLIENT -u SSH_TTY agy
   ```

3. 运行 `/logout`，然后用拥有你的订阅计划的账号登录。
4. 在 Paseo 中打开 **设置 → Providers → Antigravity** 并选择 **刷新**。

如果该行显示 `SSH session: yes`，请在非 SSH 会话的终端中执行相同步骤。第 1 步使用 `SSH_CONNECTION=1 agy models`，第 2 步使用 `SSH_CONNECTION=1 agy`。

如果想保留两份登录状态，并让 Paseo 使用 SSH 终端的那一份，请在 `~/.paseo/config.json` 中为该 Provider 设置一个 SSH 变量：

```json
{
  "agents": {
    "providers": {
      "antigravity": {
        "env": { "SSH_CONNECTION": "paseo" }
      }
    }
  }
}
```

运行 `paseo reload`，然后选择 **刷新**。之后该行会显示 `SSH session: yes (SSH_CONNECTION)`。
