---
title: Custom providers
description: Configure custom providers, alternative endpoints, profiles, custom binaries, and ACP agents in ~/.paseo/config.json.
nav: Custom providers
order: 5
---

# Custom providers

Everything beyond the [supported providers](/docs/supported-providers) lives under `agents.providers` in `~/.paseo/config.json`. You can:

- **Extend** a first-class provider to point at a different API (Z.AI, Alibaba/Qwen, a proxy, a self-hosted endpoint).
- **Add profiles**, multiple entries against the same underlying provider with different credentials or curated model lists.
- **Override the binary**, run a nightly build, a wrapper script, or a Docker image instead of the installed CLI.
- **Add ACP agents**, Gemini CLI, Hermes, or any agent speaking the Agent Client Protocol over stdio.
- **Disable** a provider you don't use.

Provider IDs must be lowercase alphanumeric with hyphens (`/^[a-z][a-z0-9-]*$/`). Every custom entry needs `extends` (a first-class provider ID or `"acp"`) and a `label`.

The examples below are a quick tour. The full, up-to-date reference is on GitHub: [docs/custom-providers.md](https://github.com/getpaseo/paseo/blob/main/docs/custom-providers.md).

## Extending a first-class provider

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

## Z.AI (GLM) coding plan

Z.AI exposes GLM models through an Anthropic-compatible endpoint. Point `ANTHROPIC_BASE_URL` at their API and use `ANTHROPIC_AUTH_TOKEN` for the key. Third-party endpoints don't support Anthropic's server-side tools, so disable `WebSearch`.

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

## Alibaba Cloud (Qwen) coding plan

Alibaba's coding plan routes Claude Code to Qwen models via an Anthropic-compatible API. Subscription keys look like `sk-sp-...` and must be created in the Singapore region.

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

## Multiple profiles

Create as many entries as you want against the same first-class provider. Each one shows up as a separate option in the app with its own credentials and models.

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

## Custom binary

`command` is an array, first element is the binary, the rest are arguments. It fully replaces the default launch command for that provider.

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

## ACP providers

Any agent that speaks [ACP](https://agentclientprotocol.com) over stdio can be added with `extends: "acp"` and a `command`. Paseo spawns the process, sends an `initialize` JSON-RPC request, and the agent reports its capabilities, modes, and models at runtime.

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

## Adding or relabeling models

`models` replaces the model list entirely. `additionalModels` merges with runtime-discovered models (ACP) or with `models`, use it to add an extra entry or relabel a discovered one without redeclaring the full list. An entry with the same `id` as a discovered model updates it in place.

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

## Disabling a provider

```json
{
  "agents": {
    "providers": {
      "copilot": { "enabled": false }
    }
  }
}
```

## Full reference

For the complete field reference (`extends`, `label`, `command`, `env`, `models`, `additionalModels`, `disallowedTools`, `enabled`, `order`), model and thinking-option schemas, and deeper examples for each plan, see [docs/custom-providers.md](https://github.com/getpaseo/paseo/blob/main/docs/custom-providers.md) on GitHub.
