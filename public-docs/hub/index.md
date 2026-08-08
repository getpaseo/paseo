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

## How it fits together

An organization holds your connections to GitHub, Slack, and Discord, and your registered daemons. Projects sit inside it, and each project has its own configuration.

```text
organization
├── connections
├── daemons
└── projects
```

A project is one set of environments and triggers. Split your work into projects the way you already split it in your head: one per product, per team, or per repository. Connections and daemons are shared across all of them, so a new project does not mean connecting GitHub again.

[How Hub works](/docs/hub/concepts) covers this properly.

## Reading order

1. [How it works](/docs/hub/concepts)
2. [Daemons](/docs/hub/daemons)
3. [Triggers](/docs/hub/triggers)
4. [Workflows](/docs/hub/workflows)
5. [Configuration](/docs/hub/configuration)

[Quickstart](/docs/hub/quickstart) goes end to end if you would rather start by doing.

## Running it

Two ways: [hosted](/docs/hub/hosted) or [self-hosted](/docs/hub/self-hosting). Everything above is the same either way.

Once Hub is running, approve durable CLI access and inspect the organization:

```sh
paseo hub login https://hub.example.com
paseo hub projects
```

The login is scoped to that exact Hub origin. Use it to connect a daemon or deploy configuration without copying an API key into each command.
