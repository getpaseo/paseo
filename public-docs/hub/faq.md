---
title: Hub FAQ
description: Common questions about triggers, providers, integrations, daemons, and replies in Paseo Hub.
nav: FAQ
order: 84
category: Hub
---

# Hub FAQ

## Do I need Hub to use Paseo?

No. Paseo runs agents on your machines without Hub. Hub adds event triggers, recurring schedules, inbound webhooks, shared run history, and team access on top of your daemons.

## Which agent providers can Hub run?

Hub runs any provider configured on your connected Paseo daemon, including Claude Code, Codex, OpenCode, Pi, and custom or plugin providers. When you create or edit a trigger, Hub queries that daemon for its available providers, models, execution modes, and thinking options.

## Where do triggers live?

You can create and edit triggers directly in the Hub dashboard under **Triggers**, or keep them as self-contained `.paseo/triggers/*.yml` files in your repository and deploy them with `paseo hub deploy`. Both paths use the same YAML schema and validation.

## Can one organization connect multiple GitHub, Linear, Slack, or Discord workspaces?

Yes. Integrations belong to the organization under **Integrations**, and each connected workspace, server, or GitHub installation gets its own slug. Set `connection` on a trigger event to target one specific integration.

## Who can trigger an agent?

For GitHub, Slack, Discord, and Linear comment or assignment triggers, Hub checks the sender against `from_users`. Setting `from_users: ["*"]` (the dashboard's **Audience: Everyone** default) allows any sender, while listing named logins or user IDs restricts access.

`linear.issue_entered_scope` requires `filters.project` and can omit `from_users`. Inbound webhooks authenticate callers with a Bearer secret (`whsec_...`), and schedules fire on Hub's own clock.

## Can an agent reply back to GitHub, Linear, Slack, or Discord?

Yes. Conversational triggers (`github.*`, `linear.*`, `slack.*`, `discord.*`) automatically grant the Hub MCP `reply` tool, which posts back to the triggering issue, pull request, or thread.

Add `run.outputs` to set `max` or `required: true`, and tell the agent to call `reply` and `finish_execution` in `run.prompt`. When Hub runs over HTTPS, replies include an **Open in Paseo** link for signed-in organization members.

## Can a schedule or webhook post to Slack or Discord?

Yes. Add [`run.tools`](/docs/hub/tools) (or configure **Integration tools** in the dashboard) to grant any trigger scoped `read` or `post` tools for explicit Slack or Discord channel IDs.

## What happens when a daemon is offline?

When Hub accepts a provider event or inbound webhook while the target daemon is offline, Hub keeps the run queued and retries dispatch until its `max_runtime` deadline expires. If the daemon reconnects in time, the queued run starts automatically, so resending the event can start a duplicate run.

Wait for **Activity** to show a terminal failure before sending a new event. Scheduled triggers continue firing at future occurrences and skip overlapping ticks while an earlier run is active.

## Does logging out disconnect my daemon?

No. The CLI login is a human credential stored under `PASEO_HOME`, while an enrolled daemon holds its own relationship credential.

Interactive `paseo hub logout` offers to disconnect a daemon connected to the same Hub before deleting the login. Non-interactive and `--json` logout never disconnect the daemon unless you pass `--disconnect-daemon`.

## Can I use Hub without GitHub?

Yes. Hub works with Linear, Slack, Discord, schedules, and inbound webhooks without connecting GitHub. GitHub is needed only for GitHub triggers or [`run.github`](/docs/hub/github) repository tokens.
