---
title: Antigravity
description: Install and configure Antigravity for Paseo.
nav: Antigravity
order: 23
category: Providers
---

# Antigravity

Run Antigravity in Paseo with your installed `agy` CLI and sign-in. This integration is not endorsed by Google.

## Getting started

Install the Antigravity CLI (`agy`) on your daemon host, then run `agy` once to sign in. In Paseo, select **Antigravity**. The provider ships with Paseo, so you do not install a plugin.

If `agy` is outside your daemon's PATH, override its command in `~/.paseo/config.json`. Use `env` for provider-specific environment variables:

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

See [Custom providers](/docs/custom-providers) for command and environment overrides.

## Permissions

**Full access** is the only permission mode. Antigravity cannot ask for permission when another app drives it, so Paseo starts `agy` with `--dangerously-skip-permissions`. Every tool call, including shell commands, runs without asking. Each session starts with a warning that explains this, including when you reopen a chat. Antigravity's own policy can still deny an action.

## Limitations

- Paseo MCP tools and steering are unavailable. Your own `agy` MCP servers still work.
- Attached images are passed as file references for the agent to read.
- After a daemon restart, Antigravity remembers the conversation, but Paseo's transcript starts fresh because `agy` does not replay its history.
