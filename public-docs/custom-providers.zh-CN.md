---
title: 自定义 Provider
description: 在 ~/.paseo/config.json 中配置自定义 Provider、替代端点、多个配置、自定义二进制和 ACP Agent。
nav: 自定义 Provider
---

# 自定义 Provider {#custom-providers}

[支持的 Provider](/docs/supported-providers) 之外的一切都配置在 `~/.paseo/config.json` 的 `agents.providers` 下。你可以：

- **扩展**一个一等 Provider，让它指向不同的 API（Z.AI、阿里巴巴/通义千问、代理或自托管端点）。
- **添加多个配置**：针对同一个底层 Provider 创建多个条目，使用不同的凭据或精选的模型列表。
- **覆盖二进制文件**：运行 nightly 构建、包装脚本或 Docker 镜像，而不是已安装的 CLI。
- **添加 ACP Agent**：Gemini CLI、Hermes，或任何通过 stdio 使用 Agent Client Protocol 的 Agent。
- **禁用**你不使用的 Provider。

编辑文件后运行 `paseo reload`。Provider 的修改会应用到之后的启动，无需重启 daemon。

Provider ID 必须是小写字母、数字和连字符（`/^[a-z][a-z0-9-]*$/`）。新的自定义 Provider 需要 `extends`（一个一等 Provider ID 或 `"acp"`）和 `label`。要覆盖内置的 Provider 插件，请使用它的 Provider ID 并省略 `extends`。对于 [Muse Code](/docs/muse-code)，在 `agents.providers.muse` 下设置命令或环境变量覆盖。

下面的示例只是快速浏览。完整、最新的参考在 GitHub 上：[docs/custom-providers.md](https://github.com/getpaseo/paseo/blob/main/docs/custom-providers.md)。

## Provider 选项 {#provider-options}

在 `agents.providers.<id>.options` 中设置默认值：

```json
{
  "agents": {
    "providers": {
      "pi": { "options": { "rpcTimeoutMs": 90000 } }
    }
  }
}
```

用 SDK 的 `config.options`（协议中的 `providerOptions`）为单个 Agent 覆盖默认值。Provider 会校验并应用合并后的记录。两层配置、深度合并规则、持久化行为以及各 Provider 的示例见 [Provider 选项](/docs/sdk/provider-options)。

## 扩展一等 Provider {#extending-a-first-class-provider}

```json
{
  "agents": {
    "providers": {
      "my-claude": {
        "extends": "claude",
        "label": "My Claude",
        "env": {
          "ANTHROPIC_API_KEY": "sk-ant-...",
          "ANTHROPIC_BASE_URL": "https://my-proxy.example.com/v1"
        }
      }
    }
  }
}
```

## Z.AI（GLM）编程套餐 {#zai-glm-coding-plan}

Z.AI 通过兼容 Anthropic 的端点提供 GLM 模型。把 `ANTHROPIC_BASE_URL` 指向它们的 API，并用 `ANTHROPIC_AUTH_TOKEN` 提供密钥。第三方端点不支持 Anthropic 的服务端工具，因此请禁用 `WebSearch`。

```json
{
  "agents": {
    "providers": {
      "zai": {
        "extends": "claude",
        "label": "ZAI",
        "env": {
          "ANTHROPIC_AUTH_TOKEN": "<your-zai-api-key>",
          "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
          "API_TIMEOUT_MS": "3000000"
        },
        "disallowedTools": ["WebSearch"],
        "models": [
          { "id": "glm-5-turbo", "label": "GLM 5 Turbo", "isDefault": true },
          { "id": "glm-5.1", "label": "GLM 5.1" }
        ]
      }
    }
  }
}
```

## 阿里云（通义千问）编程套餐 {#alibaba-cloud-qwen-coding-plan}

阿里巴巴的编程套餐通过兼容 Anthropic 的 API，把 Claude Code 路由到通义千问模型。订阅密钥形如 `sk-sp-...`，必须在新加坡区域创建。

```json
{
  "agents": {
    "providers": {
      "qwen": {
        "extends": "claude",
        "label": "Qwen (Alibaba)",
        "env": {
          "ANTHROPIC_AUTH_TOKEN": "sk-sp-<coding-plan-key>",
          "ANTHROPIC_BASE_URL": "https://coding-intl.dashscope.aliyuncs.com/apps/anthropic"
        },
        "disallowedTools": ["WebSearch"],
        "models": [
          { "id": "qwen3.5-plus", "label": "Qwen 3.5 Plus", "isDefault": true },
          { "id": "qwen3-coder-next", "label": "Qwen 3 Coder Next" }
        ]
      }
    }
  }
}
```

## 多个配置 {#multiple-profiles}

针对同一个一等 Provider，你想创建多少条目都可以。每个条目都会作为单独的选项出现在应用中，有自己的凭据和模型。

```json
{
  "agents": {
    "providers": {
      "claude-work": {
        "extends": "claude",
        "label": "Claude (Work)",
        "env": { "ANTHROPIC_API_KEY": "sk-ant-work-..." }
      },
      "claude-personal": {
        "extends": "claude",
        "label": "Claude (Personal)",
        "env": { "ANTHROPIC_API_KEY": "sk-ant-personal-..." }
      }
    }
  }
}
```

## 自定义二进制文件 {#custom-binary}

`command` 是一个数组，第一个元素是二进制文件，其余是参数。它会完全替换该 Provider 的默认启动命令。

```json
{
  "agents": {
    "providers": {
      "claude": {
        "command": ["/opt/claude-nightly/claude"]
      }
    }
  }
}
```

## ACP Provider {#acp-providers}

任何通过 stdio 使用 [ACP](https://agentclientprotocol.com) 的 Agent，都可以用 `extends: "acp"` 和 `command` 添加。Paseo 启动该进程并发送 `initialize` JSON-RPC 请求，Agent 在运行时报告它的能力、模式和模型。

```json
{
  "agents": {
    "providers": {
      "gemini": {
        "extends": "acp",
        "label": "Google Gemini",
        "command": ["gemini", "--acp"]
      },
      "hermes": {
        "extends": "acp",
        "label": "Hermes",
        "command": ["hermes", "acp"]
      }
    }
  }
}
```

## 添加模型或重新命名模型 {#adding-or-relabeling-models}

`models` 会完全替换模型列表。`additionalModels` 会与运行时发现的模型（ACP）或 `models` 合并；用它来添加一个额外条目，或重新命名一个已发现的模型，而不必重新声明整个列表。`id` 与已发现模型相同的条目会就地更新该模型。

```json
{
  "agents": {
    "providers": {
      "gemini": {
        "extends": "acp",
        "label": "Google Gemini",
        "command": ["gemini", "--acp"],
        "additionalModels": [
          { "id": "experimental-model", "label": "Experimental", "isDefault": true },
          { "id": "gemini-2.5-pro", "label": "Gemini 2.5 Pro (preferred)" }
        ]
      }
    }
  }
}
```

## 禁用 Provider {#disabling-a-provider}

```json
{
  "agents": {
    "providers": {
      "copilot": { "enabled": false }
    }
  }
}
```

## 完整参考 {#full-reference}

完整的字段参考（`extends`、`label`、`command`、`env`、`options`、`models`、`additionalModels`、`disallowedTools`、`paseoTools`、`enabled`、`order`）、模型和思考选项的 schema，以及每种套餐更深入的示例，请参见 GitHub 上的 [docs/custom-providers.md](https://github.com/getpaseo/paseo/blob/main/docs/custom-providers.md)。`paseoTools` 的配置见[按 Provider 限制 Paseo 工具](/docs/mcp#limit-paseo-tools-by-provider)。
