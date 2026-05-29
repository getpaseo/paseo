---
title: Open Source Conductor Alternative With Linux, Windows, and Mobile
description: Paseo is open source, runs on macOS, Linux, and Windows, ships native iOS and Android apps, and supports 30+ agents through the in-app catalog plus any ACP or CLI agent. Conductor is macOS only and Claude Code or Codex only.
nav: Conductor
order: 100
---

# Paseo vs Conductor

Conductor is a macOS app for running Claude Code and Codex in parallel git worktrees. Closed source.

Paseo is an app for orchestrating coding agents, with native clients on desktop, mobile, web, and the CLI. Open source (AGPL-3.0).

![Paseo desktop and mobile app](/hero-mockup.png)

## Why pick Paseo

Conductor runs on macOS, with Claude Code and Codex, in parallel git worktrees. Paseo does all of that. Pick Paseo if you want:

- Linux or Windows alongside macOS
- A native iOS and Android app
- Many more agents than Claude Code and Codex
- A CLI to script agent work and drive remote daemons
- A self-hosted daemon you can run on a server, VM, or homelab
- Open source you can audit and fork

## Architecture

The Paseo daemon runs as its own process. Desktop, web, mobile, and CLI all connect to it over a websocket. Run the daemon on your laptop, on a VM, in Docker, or across a fleet, and connect to any of them from any client.

Conductor's desktop app is the host. Agents run inside it.

## Providers

Paseo runs Claude Code, Codex, OpenCode, and Pi natively, plus 30+ more agents through the in-app catalog including GitHub Copilot, Cursor, Gemini CLI, and Amp. Paseo speaks the [Agent Client Protocol](https://agentclientprotocol.com), so any ACP agent works. Custom providers run any CLI agent. See [Supported providers](/docs/supported-providers).

Conductor runs Claude Code and Codex.

Both tools launch the official CLIs as subprocesses with your own credentials. Neither extracts tokens or proxies model calls.

## Panes

Paseo's app has split panes and tabs (⌘D for vertical, ⌘⇧D for horizontal). Panes include a terminal alongside your agents, a diff viewer, and a browser for testing running services.

## GitHub

Paseo's app handles commit, push, opening PRs, watching checks and reviews, and merging.

## CLI

Paseo has a CLI that mirrors the app:

```bash
paseo run --provider codex "implement OAuth"
paseo run --host devbox:6767 "run the test suite"
paseo ls
paseo send <agent-id> "add tests"
paseo schedule create --cron "0 9 * * 1" "audit the codebase"
```

`paseo run --host` connects to a remote daemon. `paseo schedule` runs an agent on a cron. `paseo loop` retries an agent until a verification command passes.

Conductor does not have a CLI.

## Worktrees and services

Both tools isolate parallel agents in git worktrees.

Paseo also gives each worktree its own dev server URL. Two agents running their dev servers at the same time get `web.fix-auth.my-app.localhost` and `web.add-search.my-app.localhost` instead of port collisions.

## Mobile

Paseo ships native iOS and Android apps with the same feature set as the desktop app. Conductor has no mobile app.

## Voice

Paseo's speech-to-text and text-to-speech run locally on your device. Nothing leaves your network. Conductor does not have voice.

## Comparison

|                              | Paseo                                                           | Conductor          |
| ---------------------------- | --------------------------------------------------------------- | ------------------ |
| License                      | Open source (AGPL-3.0)                                          | Closed source      |
| Platforms                    | macOS, Linux, Windows                                           | macOS only         |
| Native mobile                | iOS, Android                                                    | —                  |
| Providers                    | Claude Code, Codex, OpenCode, Pi + 30+ via ACP catalog + custom | Claude Code, Codex |
| Git worktrees                | Yes                                                             | Yes                |
| Per-worktree dev server URLs | Yes                                                             | —                  |
| Split panes and tabs         | Yes                                                             | —                  |
| In-app terminal              | Yes                                                             | Yes                |
| In-app browser               | Yes                                                             | —                  |
| GitHub workflow in app       | Commit, push, PR, checks, reviews, merge                        | Yes                |
| CLI                          | Run, `--host`, ls, send, schedule, loop                         | —                  |
| Local voice (on-device)      | Yes                                                             | —                  |
| Self-hosted daemon           | Yes                                                             | —                  |

See also: [Paseo vs Superset](/docs/alternatives/superset), [Paseo vs OpenChamber](/docs/alternatives/openchamber), [Paseo vs Happy Coder](/docs/alternatives/happy-coder).
