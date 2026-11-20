---
title: How Hub works
description: How events, schedules, and webhooks match a trigger and start an agent on your Paseo daemon.
nav: How it works
order: 62
category: Hub
---

# How Hub works

Hub connects external events, schedules, and webhooks to coding agents running on your Paseo daemons.

```text
GitHub / Linear / Slack / Discord / Schedule / Webhook
                          │
                          ▼
                         Hub
         verifies input and matches triggers
                          │
                          ▼
                     Paseo daemon
             starts or continues an agent
```

## Core concepts

- An **app** is the provider application configured for a self-hosted Hub under **Apps** (GitHub App, Linear OAuth app, Slack app, or Discord app). Hosted Hub operates its own apps.
- An **integration** is a workspace, account, or server connected to your Hub organization under **Integrations**. Each connected account has a unique connection slug, such as `acme-github` or `acme-slack`, that triggers reference.
- A **daemon** is a machine running the Paseo daemon and enrolled in your Hub organization under **Daemons**. Daemons accept agent launches only after you grant `hub.execute` from that machine.
- A **trigger** is one self-contained rule that maps an event, schedule, or webhook to a target daemon, working directory, agent configuration, prompt, and optional tools or outputs.
- **Activity** records every accepted delivery, routing decision, execution status, reply, and error across the organization.

## From event to agent

1. An event arrives via HTTPS webhooks (GitHub, Linear, Slack Webhooks, or inbound webhooks), an outbound connection (Slack Socket Mode or Discord gateway), or Hub's schedule clock.
2. Hub verifies the sender or signature and looks up matching enabled triggers.
3. For external provider events, Hub evaluates the trigger's connection, resource filters, and sender allowlist (`from_users`).
4. For each matching trigger, Hub creates a run and sends the launch intent to the target daemon over the same RPC protocol used by the Paseo app and CLI.
5. By default, events on the same Slack thread, Discord thread, GitHub issue or pull request, or Linear issue continue the existing agent session rather than starting a new one.
6. The agent runs on your machine with the Hub MCP server attached. It calls `reply` to answer the conversation, calls any granted integration tools, and calls `finish_execution` when complete.

## Authoring and validation

You can create and edit triggers in two ways:

- In the Hub dashboard under **Triggers**, using the visual form or the YAML editor.
- As `.paseo/triggers/*.yml` files in your repository, deployed with `paseo hub deploy`.

Both paths use the same YAML schema and validation. When you save or deploy a trigger, Hub verifies the YAML structure, resolves referenced connections and daemon slugs, and asks the connected daemon to validate the selected provider, model, mode, thinking option, and provider options. Invalid settings fail at save time instead of on the first run.

## Open in Paseo links

When Hub has a public HTTPS origin and a run has a recorded daemon agent, Hub appends an **Open in Paseo** link to conversation replies on GitHub, Linear, Slack, and Discord.

Clicking the link checks that the visitor is a signed-in member of that Hub organization before offering to open the exact agent in Paseo, view the execution in Hub, or install Paseo. Signed-out visitors and users outside the organization receive no run details.

Agents with scoped posting tools (`run.tools.slack` or `run.tools.discord`) also receive the same URL in their request context so digests and reports can link back to the run.

## Security boundaries

Hub verifies inbound requests, enforces sender allowlists, mints scoped GitHub tokens, and authorizes every Hub MCP tool call on the server. It does not sandbox the coding agent process on your machine.

Protect access to your Hub organization and any repository that deploys `.paseo/triggers/*.yml`. Read [Hub security](/docs/hub/security) before widening allowlists or granting repository write permissions.
