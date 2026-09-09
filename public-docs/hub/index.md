---
title: Hub
description: The layer above your daemons. Register them, give them capabilities, and share them with your team.
nav: Overview
order: 60
category: Hub
---

# Hub

A daemon runs agents on one machine, for you. Paseo Hub is the layer above your daemons. You register your daemons with it, and it gives them capabilities they do not have on their own.

```text
             Hub
    ┌─────────┼─────────┐
    ▼         ▼         ▼
 laptop    devbox    build server
```

What that gives you today:

- Agents that start on their own, from activity in GitHub, Slack, and Discord.
- Triggers you can keep in a repository and deploy from the CLI.
- A record of everything that arrived, what it matched, and what ran.
- One place for your team to see all of it.

Your daemons keep running agents where they always did. Hub decides when to ask them to.

## What lives in your repository

`paseo hub init` creates one self-contained starter trigger:

```text
.paseo/
└── triggers/
    └── slack-help.yml
```

The file names the app connection, allowed user, daemon, working directory, agent runtime, prompt, and outputs. Setup validates it and asks whether to deploy. Mentioning the bot then starts an agent on your machine. [Quickstart](/docs/hub/quickstart) runs it end to end; the [generated starter trigger](/docs/hub/configuration#generated-starter-trigger) shows what setup wrote.

## Reading order

1. [Quickstart](/docs/hub/quickstart)
2. [How it works](/docs/hub/concepts)
3. [Daemons](/docs/hub/daemons)
4. [Triggers](/docs/hub/triggers)
5. [Workflows](/docs/hub/workflows)
6. [GitHub access](/docs/hub/github)
7. [Configuration](/docs/hub/configuration)
8. [Security](/docs/hub/security)

If a workflow accepts requests from GitHub, Slack, Discord, or the API, read [Hub security](/docs/hub/security) before giving an agent access to a working directory or output capability.

## Run Hub yourself

Start on your machine with the embedded database, then add PostgreSQL or a public deployment only when you need them. [Self-hosting](/docs/hub/self-hosting) covers each step.

[Hosted Hub](/docs/hub/hosted) uses the same triggers, daemons, and activity model. [Sign in to start a free trial](https://hub.paseo.sh).
