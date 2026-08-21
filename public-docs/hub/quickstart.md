---
title: Hub quickstart
description: Run Hub locally and answer a Slack mention with an agent on your machine.
nav: Quickstart
order: 61
category: Hub
---

# Hub quickstart

Run Hub on your machine, connect it to Slack without a public server, and answer a mention with an agent in your repository. Hub's browser setup hands off to your terminal, and guided setup writes and deploys the workflow for you.

You need [Paseo installed and running](/docs), Node.js, and a Slack workspace where you can create an app.

## 1. Start Hub

```sh
npx @getpaseo/hub
```

Open the address it prints, normally <http://localhost:3000>, and create the operator account Hub asks for.

The first run needs no database, Docker, environment variables, or API keys. Hub creates an embedded database, your organization, and a **Default** project. You never create a project by hand.

## 2. Connect Slack

**Set up your apps** explains how to create the Slack app and gives you a manifest to paste into Slack. Keep **Socket Mode** selected. It connects out from Hub and needs no public address or HTTPS.

Paste the App-level token and Bot token back into Hub, then choose **Connect Slack**. Invite the bot to the channel where you will use it:

```text
/invite @Paseo
```

GitHub and Discord can wait. Their setup stays available under **Apps**.

## 3. Connect the machine your code is on

**Connect a daemon** shows one command with this Hub's address already in it:

```sh
paseo hub login http://localhost:3000
```

Run it on the machine where your code lives, in the repository the agent should work in. Guided setup records that directory as the workflow's working directory.

Approve the login in the browser tab that opens. Leave the Hub tab open: it watches for the daemon and shows **Daemon connected** by itself. **Continue** and **Do this later** both land in the Default project.

## 4. Answer the setup questions

Your terminal picks up where the login left off. Most questions arrive with a default or a suggested answer; only your Slack member ID has to be typed.

| Question                                  | What it wants                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Connect this daemon to `<hub>`?           | Yes. This enrolls the machine you are on.                                                         |
| Initialize and deploy a starter workflow? | Yes.                                                                                              |
| Starter agent provider, model, and mode   | What your daemon reports it can run. Entries marked **suggested** are that daemon's own defaults. |
| Trigger provider                          | Slack.                                                                                            |
| Your Slack member ID                      | `U01234567`, the only account allowed to trigger the bot.                                         |

Setup suggests a provider, model, and mode only when the daemon reports a complete, compatible set. A provider that has modes but no default mode is still offered; setup asks you to pick the mode instead of guessing one.

[Find your Slack IDs](/docs/hub/triggers/slack#find-your-slack-ids) has the two clicks that copy your member ID. The Slack workspace comes from the app you connected in step 2, so setup does not ask for it.

Setup then validates the bundle, writes it, and deploys:

```text
.paseo/
├── hub.yml
└── workflows/
    └── slack-help.yml
```

If `.paseo/` already exists, setup asks before replacing it. Declining the daemon connection prints `paseo hub connect <hub>`, and declining the starter workflow prints `paseo hub init`, so you can resume either one later.

## 5. Mention the bot

In the channel you invited the bot to:

```text
@Paseo have a look
```

Hub starts the agent on your daemon and posts its reply in the Slack thread. The terminal prints the project's activity URL; open it if nothing runs. [Activity](/docs/hub/activity) records every event Hub accepted, including the ones that matched nothing.

## Next

- [How Hub works](/docs/hub/concepts) — how an event becomes a workflow run on your daemon.
- [Generated starter bundle](/docs/hub/configuration#generated-starter-bundle) — the two files setup wrote, field by field.
- [Workflows](/docs/hub/workflows) — routing, prompts, and provider replies.
- [Hub security](/docs/hub/security) — read this before widening `from_users` or giving an agent GitHub authority.

Hub keeps its local state in your user data directory, normally `~/.local/share/paseo-hub`. [Self-hosting](/docs/hub/self-hosting) covers PostgreSQL, public URLs, environment-managed apps, Docker, and cloud deployment when you outgrow the local run.
