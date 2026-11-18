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

**Full access** 是唯一的权限模式。当由其他应用驱动时，Antigravity 无法请求权限，因此 Paseo 会以 `--dangerously-skip-permissions` 启动 `agy`。每次工具调用（包括 shell 命令）都不会询问就直接运行。每个会话开始时都会显示一条说明此事的警告，重新打开聊天时也会显示。Antigravity 自己的策略仍然可以拒绝某个操作。

## 限制 {#limitations}

- Paseo MCP 工具和引导功能不可用。你自己为 `agy` 配置的 MCP 服务器仍然可用。
- 附加的图片会以文件引用的形式传给 Agent 读取。
- daemon 重启后，Antigravity 会记得对话，但 Paseo 的对话记录会重新开始，因为 `agy` 不会重放它的历史。
