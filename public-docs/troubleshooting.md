---
title: Troubleshooting
description: Why Paseo can't find a provider you've installed, and how to fix the PATH and environment mismatches behind most setup issues.
nav: Common problems
order: 50
category: Troubleshooting
---

# Troubleshooting

Almost every "it works in my terminal but not in Paseo" problem is the same thing: Paseo and your terminal aren't searching the same `PATH`. This page covers how to spot that and fix it.

## Paseo can't find my provider

A provider you've installed shows as **Not installed**.

Paseo launches the agent CLIs you've already installed, it doesn't bundle them (see [Providers](/docs/providers)). So it has to find the command on its own `PATH`. If your shell only adds that location to `PATH` under certain conditions, Paseo can miss it.

### See what Paseo sees

Open **Settings → your host → Providers**, tap the provider, then tap **Diagnostic**. The rows that matter:

- **Resolved path** — where Paseo found the binary, or `not found`.
- **Daemon PATH** — the `PATH` Paseo is searching. Compare it to `echo $PATH` in a fresh terminal.
- **Version** — whether the binary actually runs.

`not found` together with a **Daemon PATH** that's missing your binary's directory is the common case: that directory is on your terminal's `PATH` but not on Paseo's.

### Fix it

The durable fix is to make sure the command is on `PATH` for a normal login shell, then restart Paseo, see [why Paseo's environment can differ](#why-paseos-environment-can-differ-from-your-terminal) for why that's the test that matters.

If you'd rather pin it directly, set the binary path in `~/.paseo/config.json`:

```json
{
  "agents": {
    "providers": {
      "claude": {
        "command": ["/absolute/path/to/claude"]
      }
    }
  }
}
```

`command` is `[binary, ...args]` and fully replaces the default launch command for that provider. Find the real path with `which -a claude`. `type -a claude` also tells you if `claude` is only a shell alias or function, those won't work, Paseo runs the binary directly, so use the path it points to. Restart the daemon after editing (see [below](#i-changed-configjson-but-nothing-happened)).

For alternative endpoints, multiple profiles, custom binaries, and ACP agents, see [Custom providers](/docs/custom-providers). For per-agent install links, see [Supported providers](/docs/supported-providers).

## Why Paseo's environment can differ from your terminal

The same mismatch shows up anywhere Paseo runs your tools, an agent, or a terminal, reporting `command not found` for something you use every day.

When you open the **desktop app** from the Dock or Finder, the OS hands it a stripped-down environment, not your terminal's `PATH`. To compensate, Paseo runs your login shell once at startup (`$SHELL -i -l -c`), captures its environment, and hands that to the daemon and everything it spawns. The rule of thumb: **if a brand-new terminal can run the command, Paseo should too.** That's also the test, open a fresh terminal and try it there.

When you start the daemon yourself from a terminal (`paseo`), there's no login-shell step, it simply inherits that terminal's environment.

Either way, the fix for a missing tool lives in your shell config (`.zshrc`, `.zprofile`, …), not in Paseo. Tools installed through version managers (asdf, mise, nvm, …) are the usual offenders, make sure they initialize for a clean login shell, not only inside one you've already opened.

This login-shell step runs on macOS and Linux. On Windows, Paseo uses the environment it was launched with.

## Reading the logs

- **Desktop app** — the login-shell resolution is logged here. Look for `[login-shell-env]`: `applied` means it worked (it logs the `PATH` before and after); `failed; keeping inherited env` means it fell back to the stripped-down environment, with a `reason` (a timeout, a non-zero exit from your shell config, no output, …). A slow or erroring `.zshrc`/`.zprofile` is the usual cause.
- **Daemon** — `~/.paseo/daemon.log` (`$PASEO_HOME/daemon.log` if you've set a custom home).

Desktop app log location:

| Platform | Path                            |
| -------- | ------------------------------- |
| macOS    | `~/Library/Logs/Paseo/main.log` |
| Linux    | `~/.config/Paseo/logs/main.log` |
| Windows  | `%APPDATA%\Paseo\logs\main.log` |

## I changed config.json but nothing happened

`config.json` is read when the daemon starts. Restart it after editing:

```bash
paseo daemon restart
```

Or in the app, open **Settings → your host → Host** and use **Restart daemon**. Running agents keep going, and clients reconnect automatically.

## Still stuck?

- [Custom providers](/docs/custom-providers) — endpoints, profiles, binaries, ACP agents.
- [Configuration](/docs/configuration) — `config.json`, environment variables, logging.
- [How Paseo resolves your login shell](https://github.com/getpaseo/paseo/blob/main/packages/desktop/src/login-shell-env.ts) — the exact code that loads your shell environment.
- [Report an issue](https://github.com/getpaseo/paseo/issues).
