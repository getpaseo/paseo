---
title: Antigravity
description: Run Antigravity in Paseo through the official agy CLI over ACP.
nav: Antigravity
order: 23
category: Providers
---

# Antigravity

Paseo runs Antigravity through the official Agent Client Protocol (`agy acp`) on your installed `agy` CLI. Paseo drives your local CLI with your existing sign-in instead of calling Google endpoints directly.

## Getting started

Antigravity is built into Paseo and enabled by default. You do not need a plugin or extra configuration.

1. Install the [Antigravity CLI](https://antigravity.google/docs/getting-started?tab=cli) (`agy`) version 1.5.0 or later on your daemon host.
2. Run `agy` in a terminal and sign in.
3. In Paseo, choose **Antigravity** when you start an agent.

If `agy` is outside your daemon PATH, use a [command override](/docs/custom-providers#custom-binary) and keep `acp` and `--disable-telemetry` in the arguments.

## Permissions

Paseo connects to `agy acp` and shows the permission modes that the CLI provides. **Full access** is the default mode.

| Mode         | Effect                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Full access  | Paseo approves tool requests that offer a single **Allow once** action. Antigravity still enforces its own tool policy. |
| Default      | Paseo shows approval requests for edits and commands that Antigravity policy requires you to approve.                   |
| Accept edits | Antigravity approves workspace edits automatically and still asks about commands that require approval.                 |
| Plan         | Antigravity plans before it acts.                                                                                       |

Scheduled runs can use **Full access** without a person to approve each tool call. Finish or stop the current turn before you switch to or from **Full access**.

## Sessions and tools

- Paseo can import CLI sessions and restore conversation history when it reopens a chat.
- Antigravity publishes slash commands and skills, accepts image attachments, and receives the MCP servers configured for the agent.
- Send a follow-up after the current turn finishes, or interrupt the turn to change direction.

After an upgrade, an older Hub trigger can report that its Antigravity model is unavailable. Open the trigger in Hub and select the model and thinking level again.

## Troubleshooting

In Paseo, open **Settings → Providers → Antigravity** and select **Diagnostic report**. The report shows the command that Paseo runs, where the daemon found `agy`, the `agy` version, the number of models, and whether `agy` runs in an SSH session.

### New models are missing

Paseo reads the model list from `agy` when the daemon starts and when you select **Refresh**. If your account gets new models after that, open **Settings → Providers → Antigravity** and select **Refresh**.

### Paseo shows different models than `agy models`

`agy` keeps two sign-ins on one machine. In an SSH session, `agy` reads its sign-in from a token file. Outside an SSH session, `agy` reads its sign-in from the keyring of the operating system. If the two sign-ins use different Google accounts, your terminal and Paseo show different models. [Antigravity CLI issue 1336](https://github.com/google-antigravity/antigravity-cli/issues/1336) tracks this behavior.

Paseo runs `agy` with the environment of the daemon. A daemon that you started from an SSH session runs `agy` in an SSH session. A daemon that a desktop session or a service manager started runs `agy` outside one. The `SSH session` row of the diagnostic report shows which one applies.

If the row shows `SSH session: no`, do these steps in a terminal on the daemon host:

1. List the models of the sign-in that Paseo uses:

   ```bash
   env -u SSH_CONNECTION -u SSH_CLIENT -u SSH_TTY agy models
   ```

2. If the list is not the one you expect, start `agy` with the same sign-in:

   ```bash
   env -u SSH_CONNECTION -u SSH_CLIENT -u SSH_TTY agy
   ```

3. Run `/logout`, then sign in with the account that has your plan.
4. In Paseo, open **Settings → Providers → Antigravity** and select **Refresh**.

If the row shows `SSH session: yes`, do the same steps in a terminal that is not an SSH session. Use `SSH_CONNECTION=1 agy models` in step 1 and `SSH_CONNECTION=1 agy` in step 2.

To keep both sign-ins and make Paseo use the one from your SSH terminal, set an SSH variable for the provider in `~/.paseo/config.json`:

```json
{
  "agents": {
    "providers": {
      "antigravity": {
        "env": { "SSH_CONNECTION": "paseo" }
      }
    }
  }
}
```

Run `paseo reload`, then select **Refresh**. The row then shows `SSH session: yes (SSH_CONNECTION)`.
