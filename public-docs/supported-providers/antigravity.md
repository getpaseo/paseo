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

Install Antigravity CLI (`agy`) 1.5.0 or later on your daemon host, then run `agy` once to sign in. In Paseo, select **Antigravity**. The provider ships with Paseo, so you do not install a plugin.

If `agy` is outside your daemon's PATH, override its command in `~/.paseo/config.json`. Use `env` for provider-specific environment variables:

```json
{
  "agents": {
    "providers": {
      "antigravity": {
        "command": ["/absolute/path/to/agy", "acp", "--disable-telemetry"],
        "env": { "EXAMPLE_VARIABLE": "value" }
      }
    }
  }
}
```

See [Custom providers](/docs/custom-providers) for command and environment overrides.

## Permissions

Paseo connects to `agy acp` and shows the permission modes the CLI offers. In **Default**, Paseo shows approval requests for edits and commands that Antigravity policy requires you to approve. In **Accept edits**, Antigravity approves workspace edits and still asks about commands that require approval. **Plan** lets Antigravity plan before it acts.

Existing Paseo chats saved in **Full access** reopen in **Default**.

## Sessions and tools

Paseo can import CLI sessions and restore conversation history when it reopens a chat. Antigravity publishes slash commands and accepts image attachments through ACP. It also receives the MCP servers configured for the agent.

Send a follow-up after the current turn finishes, or interrupt the turn to change direction.
