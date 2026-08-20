---
title: Hub quickstart
description: Run Hub locally and answer a Slack mention with an agent on your machine.
nav: Quickstart
order: 61
category: Hub
---

# Hub quickstart

Run Hub locally, connect it to Slack without a public server, and answer a mention with an agent on your machine.

You need [Paseo installed and running](/docs), Node.js, and a Slack workspace where you can create an app.

## 1. Start Hub

```sh
npx @getpaseo/hub
```

Open <http://localhost:3000>. Hub uses an embedded database by default, so this first run needs no database, environment variables, or Docker.

Create the operator account when Hub welcomes you.

## 2. Connect Slack

The next screen explains how to create the Slack app and gives you a manifest to paste into Slack. Keep **Socket Mode** selected. It connects out from Hub and does not need a public address or HTTPS.

Paste the App-level token and Bot token back into Hub, then choose **Connect Slack**. Invite the bot to the channel where you will use it:

```text
/invite @Paseo
```

You can skip GitHub and Discord for now. Their setup remains available under **Apps**.

## 3. Connect your daemon

On the machine that will run the agent:

```sh
paseo hub login http://localhost:3000
paseo hub connect
```

Approve the browser login. Hub shows the connected daemon and its slug under **Daemons**.

## 4. Create a project

Open **Projects → New project** in Hub. From the project directory, create:

```text
.paseo/
├── hub.yml
└── workflows/
    └── slack-help.yml
```

`.paseo/hub.yml` names the machine and agent configuration. Replace the daemon and directory with values from your machine:

```yaml
environments:
  dev:
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/your-repo
agents:
  codex:
    provider: codex
```

`.paseo/workflows/slack-help.yml` answers one mention in its thread:

```yaml
name: slack-help
on: slack.mention
max_runtime: 1h
steps:
  - id: answer
    environment: dev
    max_runtime: 30m
    idle_timeout: 5m
    agent: codex
    prompt:
      - text: |
          Answer with hub.reply, then call hub.finish_execution.

          <user-prompt>
          ${{ paseo.prompt }}
          </user-prompt>
    allow_outputs:
      - { type: slack.reply, max: 1, required: true }
```

This first workflow accepts mentions from anyone in the connected workspace. Add user and channel allowlists before inviting the bot to a wider audience. See [Slack triggers](/docs/hub/triggers/slack) and [Hub security](/docs/hub/security).

## 5. Deploy and mention the bot

Find the project slug and deploy the bundle:

```sh
paseo hub projects
paseo hub deploy -p your-project --dry-run
paseo hub deploy -p your-project
```

Mention the bot in the channel:

```text
@Paseo explain what this project does
```

Hub starts the agent on your daemon and posts its reply in the Slack thread. Open the project's **Activity** tab if nothing runs.

Hub keeps its local state in your user data directory (normally `~/.local/share/paseo-hub`). [Self-hosting](/docs/hub/self-hosting) covers another data directory, PostgreSQL, public URLs, Docker, and cloud deployment.
