---
title: Muse Code
description: Run Meta's Muse Code in Paseo with your installed muse CLI.
nav: Muse Code
order: 29
category: Providers
---

# Muse Code

Paseo runs Meta's Muse Code through your installed `muse` CLI (`muse serve`) over the Muse Session Protocol (MSP). It uses your existing Muse credentials and configuration.

## Getting started

Muse Code is built into Paseo and enabled by default. Use Muse 1.3.0 or later (verified with 1.4.1).

1. Install Muse Code on your daemon host:

   ```bash
   curl -fsSL https://dev.meta.ai/install.sh | sh
   ```

2. Sign in with `muse login`, or set `META_API_KEY` in the daemon environment.
3. In Paseo, choose **Muse Code** when you start an agent.

Your Muse configuration determines the available models. If `muse` is outside your daemon PATH or you need custom environment variables, see [Custom providers](/docs/custom-providers) and configure `agents.providers.muse`.

## Modes and skills

Approval modes control tool decisions separately from provider options. **Default** is the default mode.

- Available modes are **Default**, **Ask**, **Strict**, and **Full access**.
- **Full access** approves escalated approval stages automatically and keeps your effective provider options.
- Muse skills appear in the slash-command menu alongside `/compact`.

## Provider options

By default, Paseo launches Muse with the sandbox disabled (`--disable-sandbox`) and workspace trust enabled (`--trust-workspace`). Muse can install packages with your npm cache and load project rules, skills, and configuration.

| Option            | Default        | Effect                                                                                                                          |
| ----------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox.enabled` | `false`        | Enables Muse's filesystem and network sandbox. Its read-only home directory prevents npm from writing the default cache.        |
| `sandbox.network` | `"proxy-only"` | Sandbox network policy: `"proxy-only"`, `"restricted"`, or `"enabled"`. With sandbox disabled, Muse allows full network access. |
| `trustWorkspace`  | `true`         | Lets Muse load project rules, skills, and configuration.                                                                        |

To change defaults for every Muse agent, configure `agents.providers.muse.options` in `~/.paseo/config.json` on your daemon host:

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

You can also pass per-agent `providerOptions` when you create an agent. The daemon saves the per-agent options and merges them with the current provider defaults when the session opens. Invalid values or unknown keys fail session creation with a `providerOptions` error. See [Provider options](/docs/sdk/provider-options) for details.

## Limitations in Muse 1.4.1

- Paseo MCP tools are unavailable because Muse drops the returned tool namespace before matching an MCP call. This upstream issue must be fixed in Muse before Muse agents can use Paseo tools.
- Compaction needs a model context limit. If your endpoint does not report one, configure `context_compaction.provider_context_limit_tokens` in Muse for the selected model.
- Usage windows appear only when Muse reports them. An empty `usage/read` response leaves subscription usage unavailable.
- If native subagent tools are missing, set `MUSE_EXPERIMENTAL_SDK_ENABLED=on` in the provider environment. Linked child sessions appear only when Muse supplies `childSessionId`.
