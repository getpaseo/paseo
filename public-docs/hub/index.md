---
title: Hub
description: Automate coding agents on your Paseo daemons from GitHub, Linear, Slack, Discord, schedules, and webhooks.
nav: Overview
order: 60
category: Hub
---

# Hub

A Paseo daemon runs coding agents on one machine. Paseo Hub sits above your daemons so external events, schedules, and webhooks can start agents on those machines and share the history with your team.

```text
GitHub · Linear · Slack · Discord · Schedules · Webhooks
                           │
                           ▼
                          Hub
               ┌───────────┼───────────┐
               ▼           ▼           ▼
            laptop       devbox   build server
```

Hub gives your team four things:

- Event-driven agents that start from GitHub, Linear, Slack, Discord, recurring schedules, and inbound webhooks.
- Triggers you can edit in the browser or store in `.paseo/triggers/*.yml` and deploy from the CLI.
- Scoped integration tools that let any trigger read or post to Slack and Discord or act on GitHub.
- One shared activity log of deliveries, routing decisions, runs, and replies.

Your daemons still run agents on your machines with your existing subscriptions, models, and skills. Hub decides when to invoke them.

## What lives in your repository

You can manage triggers in the Hub dashboard or store each trigger as one YAML file in your repository:

```text
.paseo/
└── triggers/
    └── slack-help.yml
```

Each file is self-contained. It names the event, allowed senders, target daemon, working directory, agent configuration, prompt, and any tools or reply bounds. Run `paseo hub init` to generate a starter file, or run `paseo hub deploy` to validate and install your triggers.

## Reading order

1. [Quickstart](/docs/hub/quickstart)
2. [How it works](/docs/hub/concepts)
3. [Daemons](/docs/hub/daemons)
4. [Triggers](/docs/hub/triggers)
5. [Integration tools](/docs/hub/tools)
6. [GitHub access](/docs/hub/github)
7. [Configuration](/docs/hub/configuration)
8. [Security](/docs/hub/security)

Before giving a trigger access to a working directory, GitHub permissions, or chat channels, read [Hub security](/docs/hub/security).

## Hosted or self-hosted

[Hosted Hub](/docs/hub/hosted) manages the server and provider apps for you. Create a free account at [hub.paseo.sh](https://hub.paseo.sh) with no card and no expiry.

To run Hub on your own machine or server, start with `npx @getpaseo/hub` and an embedded database, then add PostgreSQL or a public HTTPS deployment when you need them. See [Self-hosting](/docs/hub/self-hosting).
