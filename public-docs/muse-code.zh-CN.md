---
title: Muse Code
description: 为 Paseo 安装和配置 Muse Code。
nav: Muse Code
---

# Muse Code {#muse-code}

使用你现有的 Muse 安装和凭据，在 Paseo 中运行 Meta 的终端编程 Agent。

## 开始使用 {#getting-started}

在运行 Paseo daemon 的机器上安装 Muse Code：

```bash
curl -fsSL https://dev.meta.ai/install.sh | sh
muse login
```

请使用 Muse 1.3.0 或更高版本。此集成已在 1.4.1 上验证。如需 API 访问，请在 daemon 的环境中设置 `META_API_KEY`，而不是登录。参见 [Provider 环境变量覆盖](/docs/custom-providers)。

在 Paseo 中选择 **Muse Code**，然后选择模型、审批模式和推理强度。Paseo 运行 `muse serve`，并通过 Muse Session Protocol（MSP）通信。可用的模型由你的 Muse 配置决定。

## Provider 选项 {#provider-options}

Paseo 启动 Muse 时会禁用沙箱（`--disable-sandbox`）并开启工作区信任（`--trust-workspace`）。Muse 可以使用你的 npm 缓存安装软件包，并加载项目规则、技能和配置。

在 daemon 所在机器的 `config.json` 中，于 `agents.providers.muse.options` 下为所有 Muse Agent 设置默认值：

```json
{
  "agents": {
    "providers": {
      "muse": {
        "options": {
          "sandbox": { "enabled": true, "network": "proxy-only" },
          "trustWorkspace": false
        }
      }
    }
  }
}
```

创建 Agent 时，你也可以提供每个 Agent 各自的 `providerOptions`。daemon 会把 Provider 默认值与每个 Agent 的选项合并，并把生效的 `providerOptions` 传给 Muse。配置和创建方法见 [Provider 选项](/docs/sdk/provider-options)。

每个 Agent 的选项会随 Agent 一起保存，并在刷新或恢复时打开其 Muse 主机时重新应用。无效的值和未知的键会使会话创建失败，并报告 `providerOptions` 错误。

| 选项              | 默认值         | 作用                                                                                               |
| ----------------- | -------------- | -------------------------------------------------------------------------------------------------- |
| `sandbox.enabled` | `false`        | 启用 Muse 的文件系统和网络沙箱。沙箱中的主目录是只读的，npm 无法写入默认缓存。                     |
| `sandbox.network` | `"proxy-only"` | 沙箱网络策略：`"proxy-only"`、`"restricted"` 或 `"enabled"`。禁用沙箱时，Muse 允许完全的网络访问。 |
| `trustWorkspace`  | `true`         | 允许 Muse 加载项目规则、技能和配置。                                                               |

审批模式单独控制工具决策：**Default**、**Ask**、**Strict** 和 **Full access**。Full access 会自动允许升级的审批阶段，并保留生效的 Provider 选项。技能会和 `/compact` 一起出现在斜杠命令菜单中。

## Muse 1.4.1 中的限制 {#limitations-in-muse-141}

- **Paseo MCP 工具不可用。** Muse 在匹配 MCP 调用之前丢弃了返回的工具命名空间。这是上游问题，必须先在 Muse 中修复，它的 Agent 才能使用 Paseo 工具。
- **上下文压缩需要模型的上下文上限。** 如果你的端点不报告上限，请在 Muse 中为所选模型配置 `context_compaction.provider_context_limit_tokens`。
- **只有 Muse 报告用量窗口时才会显示。** `usage/read` 返回空响应时，订阅用量将不可用。
- **原生子 Agent 可能需要 Muse 的实验性 SDK 开关。** 如果缺少原生子 Agent 工具，请在 Provider 环境中设置 `MUSE_EXPERIMENTAL_SDK_ENABLED=on`。只有当 Muse 提供 `childSessionId` 时，关联的子会话才会出现。

要在 `agents.providers.muse` 下覆盖二进制文件或环境变量，请参见[自定义 Provider](/docs/custom-providers)。
