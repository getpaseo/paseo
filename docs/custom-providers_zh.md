# 自定义 Provider 配置

Paseo 支持通过 `config.json`（位于 `$PASEO_HOME/config.json`，通常为 `~/.paseo/config.json`）配置自定义 agent provider。你可以使用不同的 API 后端扩展内置 provider、添加兼容 ACP 的 agent、设置自定义二进制文件、禁用 provider，以及为同一底层 provider 创建多个配置文件。

所有 provider 配置均位于 config.json 的 `agents.providers` 下：

```json
{
  "version": 1,
  "agents": {
    "providers": {
      "provider-id": { ... }
    }
  }
}
```

Provider ID 必须是小写字母数字加连字符（`/^[a-z][a-z0-9-]*$/`）。

---

## 目录

- [扩展内置 provider](#扩展内置-provider)
- [Z.AI（智谱）编程方案](#zai智谱编程方案)
- [阿里云（通义千问）编程方案](#阿里云通义千问编程方案)
- [使用自定义 OpenAI 兼容端点的 Codex](#使用自定义-openai-兼容端点的-codex)
- [同一 provider 的多个配置文件](#同一-provider-的多个配置文件)
- [为 provider 指定自定义二进制文件](#为-provider-指定自定义二进制文件)
- [禁用 provider](#禁用-provider)
- [ACP provider](#acp-provider)
- [Provider 覆盖参考](#provider-覆盖参考)

---

## 扩展内置 provider

使用 `extends` 创建一个从内置 provider（claude、codex、copilot、opencode、pi、omp）继承的新 provider 条目。新 provider 在 provider 列表中拥有自己的条目，具有自己的标签、环境变量和模型定义。

```json
{
  "agents": {
    "providers": {
      "my-claude": {
        "extends": "claude",
        "label": "My Claude",
        "description": "Claude with custom API endpoint",
        "env": {
          "ANTHROPIC_API_KEY": "sk-ant-...",
          "ANTHROPIC_BASE_URL": "https://my-proxy.example.com/v1"
        }
      }
    }
  }
}
```

自定义 provider 的必填字段：

- `extends` — 要继承的内置 provider ID（或 `"acp"`）
- `label` — 在 UI 中显示的名称

请参阅下方的[使用自定义 OpenAI 兼容端点的 Codex](#使用自定义-openai-兼容端点的-codex)获取专门的 Codex 示例。

---

## Z.AI（智谱）编程方案

[Z.AI](https://z.ai) 是一家中国 AI 公司（智谱 AI），提供兼容 Anthropic 的 API 端点。他们的 GLM 编程方案通过 Claude Code 的 Anthropic API 协议提供 GLM 模型的包月访问。这些**不是** Anthropic Claude 模型——它们是智谱自家的 GLM 模型，通过兼容 Anthropic 的 API 暴露出来。

### 设置

1. 在 [z.ai](https://z.ai) 注册并订阅编程方案
2. 在 Z.AI 控制台创建 API key
3. 在 config.json 中添加 provider 条目：

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
          { "id": "glm-4.5-air", "label": "GLM 4.5 Air" },
          { "id": "glm-5-turbo", "label": "GLM 5 Turbo", "isDefault": true },
          { "id": "glm-5.1", "label": "GLM 5.1" }
        ]
      }
    }
  }
}
```

### 可用模型

| 模型           | 层级                   |
| -------------- | ---------------------- |
| `glm-5.1`      | Advanced（旗舰）       |
| `glm-5-turbo`  | Advanced               |
| `glm-4.7`      | Standard               |
| `glm-4.5-air`  | Lightweight（轻量）    |

### 注意事项

- 使用 `ANTHROPIC_AUTH_TOKEN` 而非 `ANTHROPIC_API_KEY`——这是 z.ai 的 API key
- `API_TIMEOUT_MS` 环境变量用于延长请求超时时间（z.ai 可能比直接使用 Anthropic 更慢）
- 如果遇到认证错误，请在切换到 z.ai provider 之前在 Claude Code 中运行 `/logout`
- 网页搜索（`WebSearch` 工具）是 Anthropic 独有的服务端功能——第三方端点不支持。添加 `"disallowedTools": ["WebSearch"]` 以避免错误。
- 也可使用自动化设置：`npx @z_ai/coding-helper`
- 官方文档：[docs.z.ai/devpack/tool/claude](https://docs.z.ai/devpack/tool/claude)

---

## 阿里云（通义千问）编程方案

[阿里云模型服务灵积](https://www.alibabacloud.com/en/campaign/ai-scene-coding) 提供了一个编程方案，通过兼容 Anthropic 的 API 将 Claude Code 的请求路由到通义千问模型。与 z.ai 类似，这些**不是** Anthropic Claude 模型。

### 设置

1. 前往阿里云模型服务灵积的[编程方案页面](https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=globalset#/efm/coding_plan)（新加坡区域）
2. 订阅 Pro 方案（$50/月）
3. 获取你的方案专属 API key（格式：`sk-sp-xxxxx`）——这与标准的模型服务灵积 key 不同
4. 在 config.json 中添加 provider 条目：

```json
{
  "agents": {
    "providers": {
      "qwen": {
        "extends": "claude",
        "label": "Qwen (Alibaba)",
        "env": {
          "ANTHROPIC_AUTH_TOKEN": "sk-sp-<your-coding-plan-key>",
          "ANTHROPIC_BASE_URL": "https://coding-intl.dashscope.aliyuncs.com/apps/anthropic"
        },
        "disallowedTools": ["WebSearch"],
        "models": [
          { "id": "qwen3.5-plus", "label": "Qwen 3.5 Plus", "isDefault": true },
          { "id": "qwen3-coder-next", "label": "Qwen 3 Coder Next" },
          { "id": "kimi-k2.5", "label": "Kimi K2.5" }
        ]
      }
    }
  }
}
```

### API 端点

| 模式                       | Base URL                                                    |
| -------------------------- | ----------------------------------------------------------- |
| 编程方案（订阅制）         | `https://coding-intl.dashscope.aliyuncs.com/apps/anthropic` |
| 按量付费（无需订阅）       | `https://dashscope-intl.aliyuncs.com/apps/anthropic`        |

对于按量付费，使用 `ANTHROPIC_API_KEY` 搭配标准的模型服务灵积 key（`sk-xxxxx`），而非 `ANTHROPIC_AUTH_TOKEN`。

### 可用模型

**编程方案推荐模型：**

| 模型                | 备注                   |
| ------------------- | ---------------------- |
| `qwen3.5-plus`      | 支持视觉，推荐         |
| `qwen3-coder-next`  | 针对编程优化           |
| `kimi-k2.5`         | 支持视觉               |
| `glm-5`             | 智谱 GLM               |
| `MiniMax-M2.5`      | MiniMax                 |

**其他模型（按量付费）：**
`qwen3-max`、`qwen3.5-flash`、`qwen3-coder-plus`、`qwen3-coder-flash`、`qwen3-vl-plus`、`qwen3-vl-flash`

### 注意事项

- API key 必须在**新加坡区域**创建
- 编程方案仅供个人在交互式编程工具中使用
- 网页搜索（`WebSearch` 工具）是 Anthropic 独有的服务端功能——第三方端点不支持。添加 `"disallowedTools": ["WebSearch"]` 以避免错误。
- 官方文档：[alibabacloud.com/help/en/model-studio/claude-code-coding-plan](https://www.alibabacloud.com/help/en/model-studio/claude-code-coding-plan)

---

## 使用自定义 OpenAI 兼容端点的 Codex

Codex 默认与 OpenAI 的 Responses API 通信。扩展 `"codex"` 的自定义 provider 可以通过在 provider 的 `env` 中设置 `OPENAI_BASE_URL` 和 `OPENAI_API_KEY`，将 Codex 指向任何兼容 OpenAI 的端点（OpenRouter、LiteLLM、vLLM、llama.cpp server、内部网关等）。

Paseo 将这些变量传递给 Codex 的 app-server 进程，**并**将它们映射到 Codex 的线程配置中的 `model_provider` / `model_providers`，因为 Codex 从配置而非仅从 `OPENAI_BASE_URL` 读取 provider 路由。

### 设置

```json
{
  "agents": {
    "providers": {
      "my-codex": {
        "extends": "codex",
        "label": "My Codex",
        "description": "Codex via custom OpenAI-compatible endpoint",
        "env": {
          "OPENAI_API_KEY": "sk-...",
          "OPENAI_BASE_URL": "https://custom-relay.example.com"
        },
        "models": [{ "id": "custom-model", "label": "Custom Model", "isDefault": true }]
      }
    }
  }
}
```

### Paseo 在底层做了什么

在底层，对于每个自定义 Codex provider，Paseo 会将以下内容注入 Codex 的配置中：

```toml
model_provider = "my-codex"

[model_providers.my-codex]
name = "My Codex"
base_url = "https://custom-relay.example.com/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
requires_openai_auth = false
```

- `base_url` — 取自 `OPENAI_BASE_URL`。如果它尚未以 `/v1` 结尾，Paseo 会自动追加 `/v1`。尾部斜杠会被去除。
- `wire_api` — 始终为 `"responses"`（OpenAI Responses API 协议）。
- `env_key` — 当该环境变量存在且非空时设置为 `"OPENAI_API_KEY"`，以便 Codex 从 Paseo 传递的同一环境变量中读取 key。
- `requires_openai_auth` — 当提供了 `OPENAI_API_KEY` 时强制设为 `false`，以便 Codex 跳过其内置的 OpenAI 登录流程。

### 注意事项

- 端点必须支持 OpenAI **Responses API**，而不仅仅是 chat completions。许多网关（OpenRouter、LiteLLM）同时支持两者——请选择兼容 Responses 的路由。
- 显式设置 `models`。自定义端点暴露各自的模型 ID（`anthropic/claude-opus-4-7`、`qwen/qwen3-coder`、`local/llama` 等），Paseo 不会为 Codex 自动发现它们。
- 如需同时运行多个端点，定义多个条目，每个都扩展 `"codex"`，使用不同的 ID、标签和环境变量。每个都会在应用中显示为独立的 provider。
- 如果你只想覆盖二进制文件（例如 nightly 版本的 Codex），而不更改端点，请省略 `OPENAI_BASE_URL` 并使用 `command`——参见[为 provider 指定自定义二进制文件](#为-provider-指定自定义二进制文件)。

---

## 同一 provider 的多个配置文件

你可以创建多个扩展同一内置 provider 的条目。每个条目在 provider 列表中都有自己独立的凭据、模型和环境变量。

示例：两个不同的 Anthropic 账户作为独立的配置文件：

```json
{
  "agents": {
    "providers": {
      "claude-work": {
        "extends": "claude",
        "label": "Claude (Work)",
        "description": "Work Anthropic account",
        "env": {
          "ANTHROPIC_API_KEY": "sk-ant-work-..."
        }
      },
      "claude-personal": {
        "extends": "claude",
        "label": "Claude (Personal)",
        "description": "Personal Anthropic account",
        "env": {
          "ANTHROPIC_API_KEY": "sk-ant-personal-..."
        }
      }
    }
  }
}
```

每个配置文件在 Paseo 应用中显示为独立的 provider。你可以在启动 agent 时选择使用哪一个。

你还可以将配置文件与模型覆盖结合使用，为每个配置文件固定特定的模型：

```json
{
  "agents": {
    "providers": {
      "claude-fast": {
        "extends": "claude",
        "label": "Claude (Fast)",
        "models": [{ "id": "claude-sonnet-4-6", "label": "Sonnet 4.6", "isDefault": true }]
      },
      "claude-smart": {
        "extends": "claude",
        "label": "Claude (Smart)",
        "models": [{ "id": "claude-opus-4-6", "label": "Opus 4.6", "isDefault": true }]
      }
    }
  }
}
```

---

## 为 provider 指定自定义二进制文件

使用 `command` 字段覆盖启动任何 provider 所使用的命令。这是一个数组，第一个元素是二进制文件，其余是参数。

### 覆盖内置 provider 的二进制文件

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

### 使用自定义包装脚本

```json
{
  "agents": {
    "providers": {
      "claude": {
        "command": ["/usr/local/bin/my-claude-wrapper", "--verbose"]
      }
    }
  }
}
```

### 在派生 provider 上使用自定义二进制文件

```json
{
  "agents": {
    "providers": {
      "my-codex": {
        "extends": "codex",
        "label": "Codex (Custom Build)",
        "command": ["/home/user/codex-dev/target/release/codex"]
      }
    }
  }
}
```

`command` 数组完全替换该 provider 的默认命令。二进制文件必须存在于系统中——Paseo 会检查其可用性，如果未找到则将 provider 标记为不可用。

### 具有自定义会话目录的 Pi 兼容分支

OMP 已作为内置 provider 选项提供。它默认禁用；通过以下方式启用：

```json
{
  "agents": {
    "providers": {
      "omp": { "enabled": true }
    }
  }
}
```

对于其他保持 Pi 的 `--mode rpc` API 但将会话写入其他位置的分支，扩展 `pi`，替换命令，并提供 JSONL 会话目录：

```json
{
  "agents": {
    "providers": {
      "my-pi-fork": {
        "extends": "pi",
        "label": "My Pi Fork",
        "command": ["my-pi-fork"],
        "params": {
          "sessionDir": "~/.my-pi-fork/sessions"
        }
      }
    }
  }
}
```

会话目录仅用于导入在 Paseo 外部启动的会话。启动和恢复仍然通过配置的命令进行，因此此示例使用 `my-pi-fork --mode rpc --session <session-file>` 进行恢复。

---

## 禁用 provider

设置 `enabled: false` 以在 provider 列表中隐藏 provider。该 provider 将不会出现在应用或 CLI 中。

```json
{
  "agents": {
    "providers": {
      "copilot": { "enabled": false },
      "codex": { "enabled": false }
    }
  }
}
```

这对内置和自定义 provider 均适用。要重新启用，设置 `enabled: true` 或完全移除 `enabled` 字段。大多数 provider 默认启用；OMP 默认有意禁用，需要设置 `enabled: true`。

---

## ACP provider

[Agent Client Protocol (ACP)](https://agentclientprotocol.com) 是一个用于编辑器与 AI 编程 agent 之间通信的开放标准——可以将其理解为 AI agent 领域的 LSP。任何支持 ACP 的 agent 都可以作为自定义 provider 添加到 Paseo 中。

ACP agent 通过 stdio 上的 JSON-RPC 2.0 进行通信。Paseo 启动 agent 进程并通过 stdin/stdout 与之通信。

Paseo 还内置了一个应用内 ACP provider 目录，适用于常见 agent，包括 CodeWhale、Cursor、DeepAgents、DimCode、Gemini CLI、Hermes、Qwen Code 和 Kimi Code。目录条目会创建与下面所示相同的 `extends: "acp"` provider 配置。

### 添加通用 ACP provider

设置 `extends: "acp"` 并提供 `command`：

```json
{
  "agents": {
    "providers": {
      "my-agent": {
        "extends": "acp",
        "label": "My Agent",
        "command": ["my-agent-binary", "--acp"],
        "env": {
          "MY_API_KEY": "..."
        }
      }
    }
  }
}
```

ACP provider 的必填字段：

- `extends: "acp"`
- `label`
- `command` — 启动 agent 进程的命令（必须支持通过 stdio 的 ACP）

Paseo 的工具（如 subagent 创建）来自共享的内部工具目录。ACP provider 默认通过 MCP 回退接收这些工具，因为 ACP 暴露的是 `mcpServers`，而非 Paseo 的原生工具目录。某些 ACP 适配器在 `mcpServers` 非空时无法创建会话。对于这些 provider，使用 `params.supportsMcpServers: false` 禁用注入的 MCP：

```json
{
  "agents": {
    "providers": {
      "my-agent": {
        "extends": "acp",
        "label": "My Agent",
        "command": ["my-agent", "acp"],
        "params": {
          "supportsMcpServers": false
        }
      }
    }
  }
}
```

### 通用 ACP 诊断

对于 `extends: "acp"` 的 provider，Paseo 诊断会报告配置的命令、解析后的启动器二进制文件、版本输出、ACP `initialize`、ACP `session/new`、模型数量、模式和最终状态。

对于包运行器命令（如 `npx -y @google/gemini-cli --acp`），版本探测会保留包标识符并运行 `npx -y @google/gemini-cli --version`。这样可以诊断实际的 agent 包，而不仅仅是证明 `npx` 存在。

ACP 探测使用较短的超时时间和浏览器抑制环境变量，以便进入认证/浏览器流程的 agent 以诊断错误的形式失败，而不是卡住 provider 屏幕。

### 示例：Google Gemini CLI

[Gemini CLI](https://github.com/google-gemini/gemini-cli) 通过 `--acp` 标志支持 ACP。

1. 安装：`npm install -g @google/gemini-cli` 或参见 [Gemini CLI 文档](https://github.com/google-gemini/gemini-cli)
2. 通过 Google 进行认证（Gemini CLI 自行处理认证）
3. 添加到 config.json：

```json
{
  "agents": {
    "providers": {
      "gemini": {
        "extends": "acp",
        "label": "Google Gemini",
        "command": ["gemini", "--acp"]
      }
    }
  }
}
```

参考：[Gemini CLI ACP 模式文档](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md)

### 示例：Hermes（Nous Research）

[Hermes](https://github.com/NousResearch/hermes-agent) 是 Nous Research 开发的开源编程 agent，具有持久记忆和多 provider LLM 支持。它通过 `acp` 子命令支持 ACP。

1. 安装：`curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash`
2. 安装 ACP 支持：`pip install -e '.[acp]'`
3. 在 `~/.hermes/` 中配置 Hermes 凭据
4. 添加到 config.json：

```json
{
  "agents": {
    "providers": {
      "hermes": {
        "extends": "acp",
        "label": "Hermes",
        "description": "Nous Research self-improving AI agent",
        "command": ["hermes", "acp"]
      }
    }
  }
}
```

参考：[Hermes ACP 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp)

### ACP provider 在 Paseo 中的工作原理

当你使用 ACP provider 启动 agent 时：

1. Paseo 使用配置的 `command` 启动进程
2. 通过 stdin 发送 `initialize` JSON-RPC 请求
3. Agent 响应其能力、可用模式和模型
4. Paseo 创建会话并通过 ACP 协议发送提示词
5. Agent 通过 stdout 流式返回响应、工具调用和权限请求

模型和模式在运行时从 agent 进程中动态发现。如果你想覆盖模型列表（例如，筛选在 UI 中显示的模型），使用 `models` 字段：

```json
{
  "agents": {
    "providers": {
      "my-agent": {
        "extends": "acp",
        "label": "My Agent",
        "command": ["my-agent", "--acp"],
        "models": [
          { "id": "fast-model", "label": "Fast", "isDefault": true },
          { "id": "smart-model", "label": "Smart" }
        ]
      }
    }
  }
}
```

配置文件模型（在 config.json 中定义）存在时会完全替换运行时发现的模型。

如果你想保留运行时发现的模型并添加或重标记少量条目，请改用 `additionalModels`。

示例：在保留 provider 在运行时发现的所有模型的同时添加一个实验性模型：

```json
{
  "agents": {
    "providers": {
      "my-agent": {
        "extends": "acp",
        "label": "My Agent",
        "command": ["my-agent", "--acp"],
        "additionalModels": [
          { "id": "experimental-model", "label": "Experimental", "isDefault": true }
        ]
      }
    }
  }
}
```

示例：重标记一个已发现的模型，而不替换完整列表：

```json
{
  "agents": {
    "providers": {
      "my-agent": {
        "extends": "acp",
        "label": "My Agent",
        "command": ["my-agent", "--acp"],
        "additionalModels": [{ "id": "provider/model-id", "label": "My Preferred Label" }]
      }
    }
  }
}
```

当 `additionalModels` 条目与已发现模型具有相同的 `id` 时，它会原地更新该模型。

---

## Provider 覆盖参考

`agents.providers` 下的每个条目接受以下字段：

| 字段               | 类型                       | 必填             | 描述                                                     |
| ------------------ | -------------------------- | ---------------- | -------------------------------------------------------- |
| `extends`          | `string`                   | 是（仅自定义）   | 要继承的内置 provider ID，或 `"acp"`                     |
| `label`            | `string`                   | 是（仅自定义）   | 在 UI 中显示的名称                                       |
| `description`      | `string`                   | 否               | 在 UI 中显示的简短描述                                   |
| `command`          | `string[]`                 | 是（仅 ACP）     | 启动 agent 进程的命令                                    |
| `env`              | `Record<string, string>`   | 否               | 为 agent 进程设置的环境变量                              |
| `params`           | `Record<string, unknown>`  | 否               | 特定 provider 的选项，如 `supportsMcpServers: false`     |
| `models`           | `ProviderProfileModel[]`   | 否               | 静态模型列表（覆盖运行时发现）                           |
| `additionalModels` | `ProviderProfileModel[]`   | 否               | 静态模型补充（与运行时发现或 `models` 合并）             |
| `disallowedTools`  | `string[]`                 | 否               | 为此 provider 禁用的工具名称（如 `["WebSearch"]`）       |
| `enabled`          | `boolean`                  | 否               | 设为 `false` 以隐藏 provider（默认：`true`）              |
| `order`            | `number`                   | 否               | 在 provider 列表中的排序顺序                             |

### 模型定义

`models` 数组中的每个条目：

| 字段              | 类型                | 必填 | 描述                             |
| ----------------- | ------------------- | ---- | -------------------------------- |
| `id`              | `string`            | 是   | 发送给 provider 的模型标识符     |
| `label`           | `string`            | 是   | 在 UI 中显示的名称               |
| `description`     | `string`            | 否   | 简短描述                         |
| `isDefault`       | `boolean`           | 否   | 标记为默认模型选择               |
| `thinkingOptions` | `ThinkingOption[]`  | 否   | 可用的思考/推理级别              |

### 思考选项

| 字段          | 类型      | 必填 | 描述                       |
| ------------- | --------- | ---- | -------------------------- |
| `id`          | `string`  | 是   | 思考选项标识符             |
| `label`       | `string`  | 是   | 显示名称                   |
| `description` | `string`  | 否   | 简短描述                   |
| `isDefault`   | `boolean` | 否   | 标记为默认思考选项         |

### Claude settings.json 模型发现

内置 `claude` provider 会将 `~/.claude/settings.json` 中的具体模型 ID 追加到其第一方 Claude 模型列表中。Paseo 读取顶层的 `model` 字段以及这些 `env` 键：`ANTHROPIC_MODEL`、`ANTHROPIC_SMALL_FAST_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL` 和 `ANTHROPIC_DEFAULT_HAIKU_MODEL`。

这使得已为 Bedrock、OpenRouter、ollama、Z.AI 或其他兼容 Anthropic 的网关配置了 Claude Code 的用户可以直接在 Paseo 中选择确切的模型 ID。当设置 `agents.providers.claude.models` 时，它会**替换**硬编码的第一方 Claude 列表以及任何 settings.json 中发现的条目；使用 `agents.providers.claude.additionalModels` 可以保留第一方列表并在其上追加精选条目。

### 注意事项：`extends: "claude"` 与第三方端点

当自定义 provider 扩展 `"claude"` 但将 `ANTHROPIC_BASE_URL` 指向非 Anthropic API（Z.AI、阿里云/Qwen、代理）时，Claude Agent SDK 可能会尝试使用 Anthropic 独有的服务端工具，如 `WebSearch`。第三方 API 不支持这些工具，会导致错误。

使用 `disallowedTools` 禁用不支持的工具：

```json
{
  "agents": {
    "providers": {
      "my-proxy": {
        "extends": "claude",
        "label": "My Proxy",
        "env": {
          "ANTHROPIC_BASE_URL": "https://my-proxy.example.com/v1"
        },
        "disallowedTools": ["WebSearch"]
      }
    }
  }
}
```

### 有效的 `extends` 值

内置 provider：`claude`、`codex`、`copilot`、`opencode`、`pi`、`omp`

特殊值：`acp` — 创建通用 ACP provider（需要 `command`）

### 完整示例

包含多个自定义 provider 的 config.json：

```json
{
  "version": 1,
  "agents": {
    "providers": {
      "copilot": { "enabled": false },

      "zai": {
        "extends": "claude",
        "label": "ZAI",
        "env": {
          "ANTHROPIC_AUTH_TOKEN": "<zai-api-key>",
          "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic",
          "API_TIMEOUT_MS": "3000000"
        },
        "disallowedTools": ["WebSearch"],
        "models": [
          { "id": "glm-4.5-air", "label": "GLM 4.5 Air" },
          { "id": "glm-5-turbo", "label": "GLM 5 Turbo", "isDefault": true },
          { "id": "glm-5.1", "label": "GLM 5.1" }
        ]
      },

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
      },

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
