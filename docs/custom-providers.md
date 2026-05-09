# Custom Provider Configuration

Paseo supports configuring custom agent providers through `config.json` (located at `$PASEO_HOME/config.json`, typically `~/.paseo/config.json`). You can extend built-in providers with different API backends, add ACP-compatible agents, set custom binaries, disable providers, and create multiple profiles for the same underlying provider.

All provider configuration lives under `agents.providers` in config.json:

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

Provider IDs must be lowercase alphanumeric with hyphens (`/^[a-z][a-z0-9-]*$/`).

---

## Table of Contents

- [Extending a built-in provider](#extending-a-built-in-provider)
- [Z.AI (Zhipu) coding plan](#zai-zhipu-coding-plan)
- [Alibaba Cloud (Qwen) coding plan](#alibaba-cloud-qwen-coding-plan)
- [Multiple profiles for the same provider](#multiple-profiles-for-the-same-provider)
- [Custom binary for a provider](#custom-binary-for-a-provider)
- [Disabling a provider](#disabling-a-provider)
- [ACP providers](#acp-providers)
- [Provider override reference](#provider-override-reference)

---

## Extending a built-in provider

Use `extends` to create a new provider entry that inherits from a built-in provider (claude, codex, copilot, opencode, pi). The new provider gets its own entry in the provider list, with its own label, environment, and model definitions.

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

Required fields for custom providers:

- `extends` — which built-in provider to inherit from (or `"acp"`)
- `label` — display name in the UI

---

## Z.AI (Zhipu) coding plan

[Z.AI](https://z.ai) is a Chinese AI company (Zhipu AI) that offers an Anthropic-compatible API endpoint. Their GLM Coding Plan provides flat-rate access to GLM models through Claude Code's Anthropic API protocol. These are **not** Anthropic Claude models — they are Zhipu's own GLM models exposed through an Anthropic-compatible API.

### Setup

1. Register at [z.ai](https://z.ai) and subscribe to a coding plan
2. Create an API key from the Z.AI dashboard
3. Add a provider entry in config.json:

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

### Available models

| Model         | Tier                |
| ------------- | ------------------- |
| `glm-5.1`     | Advanced (flagship) |
| `glm-5-turbo` | Advanced            |
| `glm-4.7`     | Standard            |
| `glm-4.5-air` | Lightweight         |

### Notes

- `ANTHROPIC_AUTH_TOKEN` is used instead of `ANTHROPIC_API_KEY` — this is the z.ai API key
- The `API_TIMEOUT_MS` env var extends the request timeout (z.ai can be slower than direct Anthropic)
- If you get auth errors, run `/logout` inside Claude Code before switching to the z.ai provider
- Web search (`WebSearch` tool) is an Anthropic-only server-side feature — third-party endpoints don't support it. Add `"disallowedTools": ["WebSearch"]` to avoid errors.
- Automated setup is also available: `npx @z_ai/coding-helper`
- Official docs: [docs.z.ai/devpack/tool/claude](https://docs.z.ai/devpack/tool/claude)

---

## Alibaba Cloud (Qwen) coding plan

[Alibaba Cloud Model Studio](https://www.alibabacloud.com/en/campaign/ai-scene-coding) offers a coding plan that routes Claude Code requests to Qwen models through an Anthropic-compatible API. Like z.ai, these are **not** Anthropic Claude models.

### Setup

1. Go to the [Coding Plan page](https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=globalset#/efm/coding_plan) on Alibaba Cloud Model Studio (Singapore region)
2. Subscribe to the Pro plan ($50/month)
3. Obtain your plan-specific API key (format: `sk-sp-xxxxx`) — this is different from a standard Model Studio key
4. Add a provider entry in config.json:

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

### API endpoints

| Mode                            | Base URL                                                    |
| ------------------------------- | ----------------------------------------------------------- |
| Coding plan (subscription)      | `https://coding-intl.dashscope.aliyuncs.com/apps/anthropic` |
| Pay-as-you-go (no subscription) | `https://dashscope-intl.aliyuncs.com/apps/anthropic`        |

For pay-as-you-go, use `ANTHROPIC_API_KEY` with a standard Model Studio key (`sk-xxxxx`) instead of `ANTHROPIC_AUTH_TOKEN`.

### Available models

**Recommended for coding plan:**

| Model              | Notes                       |
| ------------------ | --------------------------- |
| `qwen3.5-plus`     | Vision capable, recommended |
| `qwen3-coder-next` | Optimized for coding        |
| `kimi-k2.5`        | Vision capable              |
| `glm-5`            | Zhipu GLM                   |
| `MiniMax-M2.5`     | MiniMax                     |

**Additional models (pay-as-you-go):**
`qwen3-max`, `qwen3.5-flash`, `qwen3-coder-plus`, `qwen3-coder-flash`, `qwen3-vl-plus`, `qwen3-vl-flash`

### Notes

- API keys must be created in the **Singapore region**
- The coding plan is for personal use only in interactive coding tools
- Web search (`WebSearch` tool) is an Anthropic-only server-side feature — third-party endpoints don't support it. Add `"disallowedTools": ["WebSearch"]` to avoid errors.
- Official docs: [alibabacloud.com/help/en/model-studio/claude-code-coding-plan](https://www.alibabacloud.com/help/en/model-studio/claude-code-coding-plan)

---

## Multiple profiles for the same provider

You can create multiple entries that extend the same built-in provider. Each gets its own entry in the provider list with independent credentials, models, and environment.

Example: two different Anthropic accounts as separate profiles:

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

Each profile appears as a separate provider in the Paseo app. You can select which one to use when launching an agent.

You can also combine profiles with model overrides to pin specific models per profile:

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

## Custom binary for a provider

Override the command used to launch any provider with the `command` field. This is an array where the first element is the binary and the rest are arguments.

### Override a built-in provider's binary

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

### Use a custom wrapper script

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

### Custom binary on a derived provider

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

The `command` array completely replaces the default command for that provider. The binary must exist on the system — Paseo checks for its availability and will mark the provider as unavailable if not found.

---

## Disabling a provider

Set `enabled: false` to hide a provider from the provider list. The provider will not appear in the app or CLI.

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

This works for both built-in and custom providers. To re-enable, set `enabled: true` or remove the `enabled` field entirely (providers are enabled by default).

---

## ACP providers

The [Agent Client Protocol (ACP)](https://agentclientprotocol.com) is an open standard for communication between editors and AI coding agents — think LSP but for AI agents. Any agent that supports ACP can be added to Paseo as a custom provider.

ACP agents communicate over JSON-RPC 2.0 on stdio. Paseo spawns the agent process and talks to it through stdin/stdout.

### Adding a generic ACP provider

Set `extends: "acp"` and provide a `command`:

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

Required fields for ACP providers:

- `extends: "acp"`
- `label`
- `command` — the command to spawn the agent process (must support ACP over stdio)

### Example: Google Gemini CLI

[Gemini CLI](https://github.com/google-gemini/gemini-cli) supports ACP via the `--acp` flag.

1. Install: `npm install -g @google/gemini-cli` or see [Gemini CLI docs](https://github.com/google-gemini/gemini-cli)
2. Authenticate with Google (Gemini CLI handles its own auth)
3. Add to config.json:

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

Ref: [Gemini CLI ACP mode docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md)

### Example: Hermes (Nous Research)

[Hermes](https://github.com/NousResearch/hermes-agent) is an open-source coding agent by Nous Research with persistent memory and multi-provider LLM support. It supports ACP via the `acp` subcommand.

1. Install: `curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash`
2. Install ACP support: `pip install -e '.[acp]'`
3. Configure Hermes credentials in `~/.hermes/`
4. Add to config.json:

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

Ref: [Hermes ACP docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp)

### How ACP providers work in Paseo

When you launch an agent with an ACP provider:

1. Paseo spawns the process using the configured `command`
2. Sends an `initialize` JSON-RPC request over stdin
3. The agent responds with its capabilities, available modes, and models
4. Paseo creates a session and sends prompts through the ACP protocol
5. The agent streams responses, tool calls, and permission requests back over stdout

Models and modes are discovered dynamically at runtime from the agent process. If you want to override the model list (e.g., to curate which models appear in the UI), use the `models` field:

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

Profile models (defined in config.json) completely replace runtime-discovered models when present.

If you want to keep runtime-discovered models and add or relabel a few entries, use `additionalModels` instead.

Example: add an experimental model while keeping every model the provider discovers at runtime:

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

Example: relabel a discovered model without replacing the full list:

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

When an `additionalModels` entry has the same `id` as a discovered model, it updates that model in place.

---

## Provider override reference

Every entry under `agents.providers` accepts these fields:

| Field              | Type                     | Required          | Description                                                        |
| ------------------ | ------------------------ | ----------------- | ------------------------------------------------------------------ |
| `extends`          | `string`                 | Yes (custom only) | Built-in provider ID to inherit from, or `"acp"`                   |
| `label`            | `string`                 | Yes (custom only) | Display name in the UI                                             |
| `description`      | `string`                 | No                | Short description shown in the UI                                  |
| `command`          | `string[]`               | Yes (ACP only)    | Command to spawn the agent process                                 |
| `env`              | `Record<string, string>` | No                | Environment variables to set for the agent process                 |
| `models`           | `ProviderProfileModel[]` | No                | Static model list (overrides runtime discovery)                    |
| `additionalModels` | `ProviderProfileModel[]` | No                | Static model additions (merged with runtime discovery or `models`) |
| `disallowedTools`  | `string[]`               | No                | Tool names to disable for this provider (e.g. `["WebSearch"]`)     |
| `enabled`          | `boolean`                | No                | Set to `false` to hide the provider (default: `true`)              |
| `order`            | `number`                 | No                | Sort order in the provider list                                    |

### Model definition

Each entry in the `models` array:

| Field             | Type               | Required | Description                           |
| ----------------- | ------------------ | -------- | ------------------------------------- |
| `id`              | `string`           | Yes      | Model identifier sent to the provider |
| `label`           | `string`           | Yes      | Display name in the UI                |
| `description`     | `string`           | No       | Short description                     |
| `isDefault`       | `boolean`          | No       | Mark as the default model selection   |
| `thinkingOptions` | `ThinkingOption[]` | No       | Available thinking/reasoning levels   |

### Thinking option

| Field         | Type      | Required | Description                         |
| ------------- | --------- | -------- | ----------------------------------- |
| `id`          | `string`  | Yes      | Thinking option identifier          |
| `label`       | `string`  | Yes      | Display name                        |
| `description` | `string`  | No       | Short description                   |
| `isDefault`   | `boolean` | No       | Mark as the default thinking option |

### Gotcha: `extends: "claude"` with third-party endpoints

When a custom provider extends `"claude"` but points `ANTHROPIC_BASE_URL` at a non-Anthropic API (Z.AI, Alibaba/Qwen, proxies), the Claude Agent SDK may try to use Anthropic-only server-side tools like `WebSearch`. Third-party APIs don't support these tools, causing errors.

Use `disallowedTools` to disable unsupported tools:

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

### Valid `extends` values

Built-in providers: `claude`, `codex`, `copilot`, `opencode`, `pi`

Special value: `acp` — creates a generic ACP provider (requires `command`)

### Full example

A config.json with multiple custom providers:

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
