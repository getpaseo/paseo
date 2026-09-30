---
title: Muse Code
description: Install and configure Muse Code for Paseo.
nav: Muse Code
order: 25
category: Providers
---

# Muse Code

Run Meta's terminal coding agent in Paseo with your existing Muse installation and credentials.

## Getting started

Install Muse Code on the machine running the Paseo daemon:

```bash
curl -fsSL https://dev.meta.ai/install.sh | sh
muse login
```

Use Muse 1.3.0 or newer. This integration was verified with 1.4.1. For API access, set
`META_API_KEY` in the daemon's environment instead of logging in. See
[provider environment overrides](/docs/custom-providers).

In Paseo, select **Muse Code**, then choose a model, approval mode, and reasoning effort.
Paseo runs `muse serve` and communicates over the Muse Session Protocol (MSP). Your Muse
configuration determines the available models.

## Plugin settings

Open Command Center and select **Configure Muse Code**. Changes apply when an agent's
Muse host next opens, including a refresh of an existing agent.

| Setting         | Default      | Effect                                                                                          |
| --------------- | ------------ | ----------------------------------------------------------------------------------------------- |
| Sandbox         | On           | Keeps Muse's filesystem and network sandbox enabled. Turning it off allows full network access. |
| Network         | `proxy-only` | Muse's sandbox network policy: `proxy-only`, `restricted`, or `enabled`.                        |
| Trust workspace | Off          | Lets Muse load project-scoped skills and configuration.                                         |

Approval modes control tool decisions separately: **Default**, **Ask**, **Strict**, and
**Full access**. Full access automatically allows escalated approval stages; it keeps the
sandbox setting you chose. Skills appear in the slash-command menu, alongside `/compact`.

## Limitations in Muse 1.4.1

- **Paseo MCP tools are unavailable.** Muse drops the returned tool namespace before matching
  an MCP call. This upstream issue must be fixed in Muse before its agents can use Paseo tools.
- **Compaction needs a model context limit.** If your endpoint does not report one, configure
  `context_compaction.provider_context_limit_tokens` in Muse for the selected model.
- **Usage windows appear only when Muse reports them.** An empty `usage/read` response
  leaves subscription usage unavailable.
- **Native subagents may need Muse's experimental SDK flag.** Set
  `MUSE_EXPERIMENTAL_SDK_ENABLED=on` in the provider environment if native subagent tools
  are missing. Linked child sessions appear only when Muse supplies `childSessionId`.

See [custom providers](/docs/custom-providers) to override the binary or environment under
`agents.providers.muse`.
