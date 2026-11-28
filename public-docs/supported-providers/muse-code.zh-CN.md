---
title: Muse Code
description: 使用已安装的 muse CLI 在 Paseo 中运行 Meta 的 Muse Code。
nav: Muse Code
---

# Muse Code {#muse-code}

Paseo 通过你已安装的 `muse` CLI（`muse serve`）经由 Muse Session Protocol（MSP）运行 Meta 的 Muse Code。它使用你现有的 Muse 凭据和配置。

## 开始使用 {#getting-started}

Muse Code 内置于 Paseo 且默认启用。请使用 Muse 1.3.0 或更高版本（已在 1.4.1 上验证）。

1. 在 daemon 主机上安装 Muse Code：

   ```bash
   curl -fsSL https://dev.meta.ai/install.sh | sh
   ```

2. 运行 `muse login` 登录，或在 daemon 环境中设置 `META_API_KEY`。
3. 在 Paseo 中启动 Agent 时选择 **Muse Code**。

可用的模型由你的 Muse 配置决定。如果 `muse` 不在 daemon 的 PATH 中，或需要自定义环境变量，请参见[自定义 Provider](/docs/custom-providers)并配置 `agents.providers.muse`。

## 模式和技能 {#modes-and-skills}

审批模式与 Provider 选项分开控制工具决策。**Default** 是默认模式。

- 可用模式包括 **Default**、**Ask**、**Strict** 和 **Full access**。
- **Full access** 会自动批准升级的审批阶段，并保留生效的 Provider 选项。
- Muse 技能会和 `/compact` 一起出现在斜杠命令菜单中。

## Provider 选项 {#provider-options}

默认情况下，Paseo 启动 Muse 时会禁用沙箱（`--disable-sandbox`）并启用工作区信任（`--trust-workspace`）。Muse 可以使用你的 npm 缓存安装软件包，并加载项目规则、技能和配置。

| 选项              | 默认值         | 作用                                                                                               |
| ----------------- | -------------- | -------------------------------------------------------------------------------------------------- |
| `sandbox.enabled` | `false`        | 启用 Muse 的文件系统和网络沙箱。沙箱中的主目录是只读的，npm 无法写入默认缓存。                     |
| `sandbox.network` | `"proxy-only"` | 沙箱网络策略：`"proxy-only"`、`"restricted"` 或 `"enabled"`。禁用沙箱时，Muse 允许完全的网络访问。 |
| `trustWorkspace`  | `true`         | 允许 Muse 加载项目规则、技能和配置。                                                               |

要为所有 Muse Agent 更改默认值，请在 daemon 主机的 `~/.paseo/config.json` 中配置 `agents.providers.muse.options`：

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

创建 Agent 时，你也可以传入每个 Agent 各自的 `providerOptions`。daemon 会保存每个 Agent 的选项，并在会话打开时将它们与当前的 Provider 默认值合并。无效的值或未知的键会使会话创建失败，并报告 `providerOptions` 错误。详情见 [Provider 选项](/docs/sdk/provider-options)。

## Muse 1.4.1 中的限制 {#limitations-in-muse-141}

- Paseo MCP 工具不可用，因为 Muse 在匹配 MCP 调用前会丢弃返回的工具命名空间。此上游问题必须先在 Muse 中修复，Muse Agent 才能使用 Paseo 工具。
- 上下文压缩需要模型的上下文上限。如果你的端点不报告上限，请在 Muse 中为所选模型配置 `context_compaction.provider_context_limit_tokens`。
- 只有 Muse 报告用量窗口时才会显示。`usage/read` 返回空响应时，订阅用量不可用。
- 如果缺少原生子 Agent 工具，请在 Provider 环境中设置 `MUSE_EXPERIMENTAL_SDK_ENABLED=on`。只有当 Muse 提供 `childSessionId` 时，关联的子会话才会出现。
