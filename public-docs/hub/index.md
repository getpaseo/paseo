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
- Configuration that lives in a repository and deploys when you push.
- A record of everything that arrived, what it matched, and what ran.
- One place for your team to see all of it.

Your daemons keep running agents where they always did. Hub decides when to ask them to.

## What you write

One project resource file names environments and complete agent configurations. Each discovered workflow file keeps one trigger beside its ordered steps:

```text
.paseo/
├── hub.yml
└── workflows/
    ├── slack-help.yml
    └── partials/
        └── answer.md
```

Push the bundle, mention the bot, and an agent starts on your machine. [Quickstart](/docs/hub/quickstart) builds the first bundle; [Workflows](/docs/hub/workflows) covers routing and provider-specific replies.

## Reading order

1. [How it works](/docs/hub/concepts)
2. [Daemons](/docs/hub/daemons)
3. [Triggers](/docs/hub/triggers)
4. [Workflows](/docs/hub/workflows)
5. [GitHub access](/docs/hub/github)
6. [Configuration](/docs/hub/configuration)
7. [Security](/docs/hub/security)

[Quickstart](/docs/hub/quickstart) goes end to end if you would rather start by doing.

If a workflow accepts requests from GitHub, Slack, Discord, or the API, read [Hub security](/docs/hub/security) before giving an agent access to a working directory or output capability.

## Where it runs

Everything on this page and the pages it links to works the same way on [hosted Hub](/docs/hub/hosted) and on a Hub you run yourself under [self-hosting](/docs/hub/self-hosting).
