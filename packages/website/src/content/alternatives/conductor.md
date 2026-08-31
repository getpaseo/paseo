---
title: Open Source Conductor Alternative With Linux, Windows, and Mobile
description: Paseo is an open source Conductor alternative with Linux, Windows, native mobile apps, a self-hosted daemon, and an extensible client.
nav: Conductor
order: 50
---

# Paseo vs Conductor

Conductor is a proprietary macOS app for running Claude Code, Codex, Cursor, and OpenCode in parallel Git worktrees and managed cloud workspaces.

Paseo is an app for orchestrating coding agents, with native clients on desktop, mobile, web, and the CLI. Open source (Apache-2.0).

![Paseo desktop and mobile app](/hero-mockup.png)

## The main difference

Conductor provides free local workspaces on macOS. Its managed cloud workspaces, API, collaboration features, and forthcoming mobile app are included in the $50 per month Pro plan.

Conductor raised a $22 million Series A and is proprietary. Paseo is independent, Apache 2.0 licensed, available on macOS, Linux, Windows, iOS, and Android, and can connect to machines you control.

## Architecture

The Paseo daemon runs as its own process. Desktop, web, mobile, and CLI all connect to it over a websocket. Run the daemon on your laptop, on a VM, in Docker, or across a fleet, and connect to any of them from any client.

Conductor runs local workspaces through its macOS app and cloud workspaces in managed Vercel sandboxes. It does not currently support connecting its clients to a cloud machine you operate.

## Providers

Paseo runs Claude Code, Codex, OpenCode, and Pi natively, plus 30+ more agents through the in-app catalog including GitHub Copilot, Cursor, Gemini CLI, and Amp. Paseo speaks the [Agent Client Protocol](https://agentclientprotocol.com), so any ACP agent works. Custom providers run any CLI agent. See [all supported providers](/agents).

Conductor supports Claude Code, Codex, Cursor, and OpenCode.

Both tools use your provider credentials. Paseo launches the provider installed on your machine. Conductor bundles managed Claude Code and Codex binaries and provides managed integrations for Cursor and OpenCode.

## Application plugins

[Paseo plugins](/docs/plugins) extend Paseo itself. They can add server behavior and native client components such as workspace panels, sidebar items, composer attachments, themes, and Command Center items across desktop, browser, iOS, and Android.

Conductor does not document an application extension API for adding both server behavior and native client components.

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

`paseo run --host` connects to a remote daemon. `paseo schedule` runs an agent on a cron.

Conductor lists its API as a Pro feature but does not document a user-facing CLI comparable to Paseo's.

## Worktrees and services

Both tools isolate parallel agents in git worktrees.

Paseo also gives each worktree its own dev server URL. Two agents running their dev servers at the same time get `web.fix-auth.my-app.localhost` and `web.add-search.my-app.localhost` instead of port collisions.

## Mobile

Paseo ships native iOS and Android apps today. Conductor lists its mobile app as coming soon under the Pro plan.

## Voice

Paseo supports local speech-to-text and text-to-speech. Conductor does not currently document a voice interface.

## Comparison

|                              | Paseo                                                           | Conductor                            |
| ---------------------------- | --------------------------------------------------------------- | ------------------------------------ |
| License                      | Open source (Apache-2.0)                                        | Closed source                        |
| Platforms                    | macOS, Linux, Windows                                           | macOS only                           |
| Native mobile                | iOS, Android                                                    | Coming soon under Pro                |
| Providers                    | Claude Code, Codex, OpenCode, Pi + 30+ via ACP catalog + custom | Claude Code, Codex, Cursor, OpenCode |
| Git worktrees                | Yes                                                             | Yes                                  |
| Per-worktree dev server URLs | Yes                                                             | —                                    |
| Split panes and tabs         | Yes                                                             | —                                    |
| In-app terminal              | Yes                                                             | Yes                                  |
| In-app browser               | Yes                                                             | —                                    |
| GitHub workflow in app       | Commit, push, PR, checks, reviews, merge                        | Yes                                  |
| CLI                          | Run, `--host`, ls, send, schedule, loop                         | —                                    |
| Application plugins          | Server code and native client components                        | No                                   |
| Local voice                  | Yes                                                             | Not documented                       |
| Self-hosted daemon           | Yes                                                             | —                                    |

See also: [Paseo vs Superset](/alternatives/superset), [Paseo vs OpenChamber](/alternatives/openchamber), [Paseo vs Happy Coder](/alternatives/happy-coder).
