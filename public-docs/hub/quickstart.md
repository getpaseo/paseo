---
title: Hub quickstart
description: Run Hub locally and answer a Slack mention with an agent on your machine.
nav: Quickstart
order: 61
category: Hub
---

# Hub quickstart

Run Hub on your machine, connect Slack over Socket Mode without a public server, and answer a mention with an agent in your repository.

You need [Paseo installed and running](/docs), Node.js, and a Slack workspace where you can create an app.

## 1. Start Hub

Run Hub locally:

```sh
npx @getpaseo/hub
```

Open the printed address, normally <http://localhost:3000>, and create the operator account. The first run needs no external database, Docker, or environment variables. Hub creates an embedded database and your organization automatically.

Hub opens **Home** with a guided four-step setup: connect an integration, connect a daemon, create a trigger, and run it.

## 2. Connect Slack

Open **Apps → Slack** and keep **Socket Mode** selected. Socket Mode connects out from Hub and needs no public HTTPS address.

Follow the steps in Hub to create the Slack app from the generated manifest, create an App-level token with `connections:write`, and install the app. Paste the App-level token and Bot token into Hub, then choose **Connect Slack**.

Invite the bot to the Slack channel where you will mention it:

```text
/invite @Paseo
```

You can set up GitHub, Linear, and Discord later under **Apps**.

## 3. Connect your machine

Open the repository where the agent will work, then log in to your local Hub:

```sh
paseo hub login http://localhost:3000
```

Approve the login in your browser. In the terminal, answer **Yes** to connect this daemon to Paseo Hub and **Yes** to allow Hub automations to run agents on it.

Execution permission defaults to no. If you answered no, grant it from the machine later:

```sh
paseo hub permissions grant hub.execute
```

## 4. Create the starter trigger

From the same repository directory, generate and deploy a starter trigger:

```sh
paseo hub init
```

Choose your local Hub endpoint (`http://localhost:3000`) and select your Slack connection if prompted. Setup asks three questions:

| Prompt                                  | Value to provide                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| Starter agent provider, model, and mode | Any enabled provider on your daemon. Suggested model and mode entries are its defaults. |
| Your Slack member ID                    | Your Slack ID, such as `U01234567`. Only listed users can trigger the bot.              |
| Deploy now?                             | Yes, to validate and install the trigger in Hub.                                        |

See [Find your Slack IDs](/docs/hub/triggers/slack#find-your-slack-ids) to copy your member ID.

Setup validates the agent configuration against your connected daemon, writes `.paseo/triggers/slack-help.yml`, and deploys it. If you skip deployment during setup, run `paseo hub deploy` from the repository root when ready.

You can also create and edit triggers directly in the Hub dashboard under **Triggers**.

## 5. Mention the bot

In the Slack channel you invited the bot to, send a mention:

```text
@Paseo summarize this repository
```

Hub starts the agent on your daemon and posts the reply in the Slack thread. Open **Triggers** or **Activity** in Hub to inspect the delivery and run. When Hub runs behind HTTPS, replies also include an **Open in Paseo** link so organization members can jump straight to the live session.

If nothing runs, check [Activity](/docs/hub/activity) to tell a filtered mention from an unrouted event.

## Next

- [How Hub works](/docs/hub/concepts) explains integrations, daemons, triggers, and continuation.
- [Triggers](/docs/hub/triggers) lists all event sources, including GitHub, Linear, schedules, and webhooks.
- [Generated starter trigger](/docs/hub/configuration#generated-starter-trigger) walks through `.paseo/triggers/slack-help.yml`.
- [Hub security](/docs/hub/security) explains host boundaries and safe allowlists before you add more users or permissions.

Hub stores local data under `~/.local/share/paseo-hub` by default. See [Self-hosting](/docs/hub/self-hosting) when you are ready for PostgreSQL or a public HTTPS deployment.
