---
title: Hub quickstart
description: Run Hub locally and answer a Slack mention with an agent on your machine.
nav: Quickstart
order: 61
category: Hub
---

# Hub quickstart

Run Hub on your machine, connect it to Slack without a public server, and answer a mention with an agent in your repository. Hub's browser setup hands off to your terminal, and `paseo hub init` writes and deploys a starter trigger for you.

You need [Paseo installed and running](/docs), Node.js, and a Slack workspace where you can create an app.

## 1. Start Hub

```sh
npx @getpaseo/hub
```

Open the address it prints, normally <http://localhost:3000>, and create the operator account Hub asks for.

The first run needs no database, Docker, environment variables, or API keys. Hub creates an embedded database and your organization.

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

Run it on the machine where your code lives, in the repository the agent should work in. Run the initializer below from that directory so it becomes the trigger's working directory.

Approve the login in the browser tab that opens. Leave the Hub tab open: it watches for the daemon and shows **Daemon connected** by itself. Choose **Continue** when the daemon is connected.

## 4. Create the starter trigger

After approving login, answer **Yes** to **Connect this daemon to Paseo Hub?** and **Allow Hub automations to run agents on this daemon?**. Execution permission defaults to no, so enable it explicitly for this setup.

Then run:

```sh
paseo hub init
```

Choose **Custom endpoint** and confirm `http://localhost:3000`. Setup reuses your login and daemon connection, then lists the app connections ready for this trigger. With one Slack workspace connected, it selects that connection automatically. With several usable connections, choose the **Trigger connection**. If none is ready, setup sends you to **Hub → Apps** and stops before selecting an agent or writing files.

| Question                                | What it wants                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| Starter agent provider, model, and mode | A runtime available on your daemon. Suggested model and mode entries are its defaults. |
| Your Slack member ID                    | `U01234567`, the only account allowed to trigger the bot.                              |
| Deploy now?                             | Yes, to activate this trigger in Hub.                                                  |

Providers must expose a selectable model and execution mode. If there is no default mode, choose the one the agent should use. [Find your Slack IDs](/docs/hub/triggers/slack#find-your-slack-ids) explains how to copy your member ID. The Slack workspace comes from the selected app connection.

Setup validates the trigger and writes:

```text
.paseo/
└── triggers/
    └── slack-help.yml
```

If `slack-help.yml` already exists, setup asks before replacing that file. Other files remain in place. If you decline deployment, run `paseo hub deploy` from this repository when ready.

## 5. Mention the bot

In the channel you invited the bot to:

```text
@Paseo have a look
```

Hub starts the agent on your daemon and posts its reply in the Slack thread. The terminal links to **Triggers**, where you can manage the trigger and inspect its runs. If nothing runs, [Activity](/docs/hub/activity) tells a filtered mention from one that never matched a trigger.

## Next

- [How Hub works](/docs/hub/concepts) — how an event becomes a workflow run on your daemon.
- [Generated starter trigger](/docs/hub/configuration#generated-starter-trigger) — the file setup wrote, field by field.
- [Workflows](/docs/hub/workflows) — routing, prompts, and provider replies.
- [Hub security](/docs/hub/security) — read this before widening `from_users` or giving an agent GitHub authority.

Hub keeps its local state in your user data directory, normally `~/.local/share/paseo-hub`. [Self-hosting](/docs/hub/self-hosting) covers deployment and advanced configuration when you outgrow the local run.
