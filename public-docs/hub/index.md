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

A file in your repository at `.paseo/hub.yml` says which events start an agent, and where it runs. This one answers a Slack mention in the thread it came from:

```yaml
environments:
  - name: development
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/project

triggers:
  - name: slack-help
    on: slack.mention
    max_runtime: 2h
    filters:
      workspace: T01234567
      channels: [C01234567]
      from_users: [U01234567]
    steps:
      - id: answer
        environment: development
        max_runtime: 30m
        idle_timeout: 5m
        agent:
          provider: codex
          mode: full-access
        prompt:
          - text: |
              Help with this request.

              Call hub.reply to send your response to the originating conversation.
              Call hub.finish_execution when the step is complete.
          - text: |
              <user-prompt>
              ${{ paseo.prompt }}
              </user-prompt>
        allow_outputs:
          - type: slack.reply
```

Push it, mention the bot, and an agent starts on your machine. [Workflows](/docs/hub/workflows) builds from here through progress updates, typed inputs, and agents that choose their own model or repository.

## Reading order

1. [How it works](/docs/hub/concepts)
2. [Daemons](/docs/hub/daemons)
3. [Triggers](/docs/hub/triggers)
4. [Workflows](/docs/hub/workflows)
5. [Configuration](/docs/hub/configuration)
6. [Security](/docs/hub/security)

[Quickstart](/docs/hub/quickstart) goes end to end if you would rather start by doing.

If a workflow accepts requests from GitHub, Slack, Discord, or the API, read [Hub security](/docs/hub/security) before giving an agent access to a working directory or output capability.

## Where it runs

Everything on this page and the pages it links to works the same way on [hosted Hub](/docs/hub/hosted) and on a Hub you run yourself under [self-hosting](/docs/hub/self-hosting).
