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

## 3. Initialize the project

From the repository where the agent should work:

```sh
paseo hub init
```

Choose **Custom endpoint…** and enter `http://localhost:3000`, then choose Slack. The guided setup:

- signs you in through the browser;
- connects the local Paseo daemon;
- uses the default project created during first-run setup;
- selects the connected Slack workspace and asks for your Slack username;
- writes `.paseo/hub.yml` and `.paseo/workflows/slack-help.yml`;
- validates the generated bundle and offers to deploy it.

Accept the default **Deploy now?** choice. The generated workflow accepts mentions only from the username you entered.

## 4. Mention the bot

Mention the bot in the channel:

```text
@Paseo explain what this project does
```

Hub starts the agent on your daemon and posts its reply in the Slack thread. Open the project's **Activity** tab if nothing runs.

Hub keeps its local state in your user data directory (normally `~/.local/share/paseo-hub`). [Self-hosting](/docs/hub/self-hosting) covers PostgreSQL, public URLs, environment-managed apps, Docker, and cloud deployment. [Configuration](/docs/hub/configuration) explains the generated files and manual deployment.
