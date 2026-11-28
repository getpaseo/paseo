---
title: Codex
description: Run Codex in Paseo using the official Codex CLI and your existing OpenAI account.
nav: Codex
order: 25
category: Providers
---

# Codex

Paseo runs Codex through the official `codex` CLI and its app-server interface. It uses your local installation and existing OpenAI sign-in.

## Getting started

Codex is built into Paseo and enabled by default.

1. Install the [Codex CLI](https://developers.openai.com/codex/cli) on your daemon host:

   ```bash
   npm install -g @openai/codex
   ```

2. Sign in with ChatGPT for subscription access:

   ```bash
   codex login
   ```

3. In Paseo, choose **Codex** when you start an agent.

To bill through an OpenAI Platform API key instead, run `printenv OPENAI_API_KEY | codex login --with-api-key` on macOS or Linux. On Windows PowerShell, run `$env:OPENAI_API_KEY | codex login --with-api-key`. See [Codex authentication](https://learn.chatgpt.com/docs/auth) for more sign-in details.

If `codex` is outside your daemon PATH, use a [command override](/docs/custom-providers#custom-binary).

## Does Codex cost extra in Paseo?

No. Paseo does not add a charge for Codex. Sign in with ChatGPT to use the access included in your ChatGPT plan. Or sign in with an API key to bill through your OpenAI Platform account.

Your plan's normal Codex limits and OpenAI's standard API pricing still apply.

## Codex is missing in Paseo

The ChatGPT desktop app and the Codex CLI are separate installs. Installing the desktop app does not add the `codex` command for Paseo.

Make sure that `codex` is on your `PATH`:

```bash
# macOS or Linux
which -a codex

# Windows
where.exe codex
```

If the command is not found:

1. Install the [Codex CLI](https://developers.openai.com/codex/cli).
2. Sign in with `codex login` or an API key.
3. If the Paseo daemon was already running when you installed the CLI, restart Paseo.
4. In Paseo, open **Settings → Host → Providers → Codex** and select **Refresh**.

Codex becomes available once Paseo can find and start the `codex` command.

## A Codex model is missing

The built-in Codex provider gets its model list from the Codex CLI that the Paseo daemon starts. If you have multiple Codex installations, they can report different models for the same account.

On the daemon host, check which executable Paseo uses and what models it offers:

```bash
paseo provider diagnostic codex
paseo provider models codex
```

Compare the diagnostic’s `Resolved path` and `Version` with the installation where you can select the model. If they differ, set [`agents.providers.codex.command`](/docs/custom-providers#custom-binary) in `~/.paseo/config.json` to an array containing that executable’s absolute path. Run `paseo reload`, then `paseo provider models codex` to verify the model is available for new agents.

## Use Codex in the Paseo terminal

Codex also works inside the Paseo terminal. Open a terminal in your workspace and run `codex` for the standard CLI experience.

You can use the terminal from Paseo's desktop, web, or mobile app. You keep access to your workspace, git changes, and other Paseo tools.

## See also

- [Supported providers](/docs/supported-providers), for other agents you can run alongside Codex.
- [Custom providers](/docs/custom-providers), for custom binaries, third-party endpoints, or multiple Codex profiles.
- [Paseo vs Codex app](/alternatives/codex-app), for a feature comparison.
