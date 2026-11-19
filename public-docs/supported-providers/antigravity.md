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

Paseo drives `agy acp --stdio` and exposes three permission modes: **Default** (asks before
running shell commands or editing files), **Accept edits** (auto-approves file edits and reads
while asking before shell commands), and **Full access** (auto-approves all tool calls).
Interactive `ask_question` prompts are surfaced as question cards in Paseo.

Switch accounts in `agy`; Paseo checks the shared sign-in store once a second and again before
starting a turn. It stops old-account runtimes and loads the same conversation with the current
credentials on your next message. An account switch interrupts an active turn or background work;
send the message again after signing in. Ordinary token renewal keeps the runtime running.
Local Linux keyring monitoring requires `python3` with the `dbus` module (`python3-dbus` on
Debian/Ubuntu). SSH and file-backed sign-ins use the CLI's credential file instead.
On headless Linux hosts where D-Bus is running without an activatable Secret Service, Paseo
also follows the CLI's file fallback. A locked keyring or temporary read error keeps the existing
runtime until the sign-in store can be read again.

Mid-turn steering is unavailable. Configured MCP servers and system prompts are forwarded to the
ACP session, and attached images are passed as file references for the agent to read. Paseo also
surfaces Antigravity account quota windows and AI Credits in the usage panel, streams native
subagents into the subagents track, and wakes sessions automatically when background commands,
schedules, or subagents complete.
