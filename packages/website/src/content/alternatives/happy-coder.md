---
title: Happy Coder Alternative With Worktrees and Multi-Provider Support
description: Paseo adds managed worktrees, native clients across desktop and mobile, and extensible daemon and client surfaces to a remote coding-agent workflow.
nav: Happy Coder
order: 53
---

# Paseo vs Happy Coder

Happy Coder connects Claude Code and Codex sessions across its macOS, web, iOS, and Android apps. It wraps the agent CLI on your laptop and syncs sessions over an end-to-end encrypted relay. Open source under MIT.

Paseo is an app for orchestrating coding agents, with native clients on desktop, mobile, web, and the CLI. Open source (Apache-2.0).

![Paseo desktop and mobile app](/hero-mockup.png)

## The main difference

Happy Coder focuses on connecting Claude Code and Codex sessions to its mobile, web, and macOS clients through an end-to-end encrypted relay.

Paseo supports the same two providers alongside OpenCode, Pi, ACP agents, and custom providers. It also manages workspaces, worktrees, services, pull-request review, and application plugins through the same daemon.

## Architecture

Paseo runs the agent inside its own daemon. The daemon owns the agent lifecycle, the worktree, and the dev servers. Clients connect over a websocket and drive the daemon.

Happy Coder runs the agent through its CLI on your laptop and syncs the session to its desktop, mobile, and web clients through an end-to-end encrypted relay.

## Panes

Paseo's app has split panes and tabs (⌘D for vertical, ⌘⇧D for horizontal). Panes include a terminal alongside your agents, a diff viewer, and a browser for testing running services.

Happy Coder's macOS app places conversations beside files, diffs, terminals, and previews.

## GitHub

Paseo's app handles commit, push, opening PRs, watching checks and reviews, and merging.

## Mobile

Both tools ship native iOS and Android apps.

## Providers

Paseo runs Claude Code, Codex, OpenCode, and Pi natively, plus 30+ more agents through the in-app catalog including GitHub Copilot, Cursor, Gemini CLI, and Amp. Paseo speaks the [Agent Client Protocol](https://agentclientprotocol.com), so any ACP agent works. Custom providers run any CLI agent. See [all supported providers](/agents).

Happy Coder runs Claude Code and Codex.

## Application plugins

[Paseo plugins](/docs/plugins) extend Paseo itself. They can add server behavior and native client components such as workspace panels, sidebar items, composer attachments, themes, and Command Center items across desktop, browser, iOS, and Android.

Happy Coder does not document an application extension API for adding both server behavior and native client components.

## Worktrees and services

Paseo runs each agent in its own git worktree. Each worktree gets its own dev server URL like `web.fix-auth.my-app.localhost`, so parallel agents don't fight for the same port.

Happy Coder can start an agent in a selected machine path, including an existing Git worktree. It does not currently create or manage the worktree lifecycle.

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

Happy Coder has CLIs for launching wrapped sessions and for creating, sending to, monitoring, and stopping remote sessions. It does not document schedules or loops.

## Voice

Both products support voice interaction. Paseo can run speech-to-text and text-to-speech locally on the device.

## Comparison

|                              | Paseo                                                           | Happy Coder                 |
| ---------------------------- | --------------------------------------------------------------- | --------------------------- |
| License                      | Open source (Apache-2.0)                                        | Open source (MIT)           |
| Desktop app                  | macOS, Linux, Windows                                           | macOS                       |
| Native mobile                | iOS, Android                                                    | iOS, Android                |
| Architecture                 | Daemon owns agent lifecycle                                     | Wraps the agent CLI         |
| Providers                    | Claude Code, Codex, OpenCode, Pi + 30+ via ACP catalog + custom | Claude Code, Codex          |
| Split workspace              | Yes                                                             | Yes                         |
| In-app terminal              | Yes                                                             | Yes                         |
| In-app browser / preview     | Yes                                                             | Yes                         |
| GitHub workflow in app       | Commit, push, PR, checks, reviews, merge                        | —                           |
| Managed Git worktrees        | Yes                                                             | Existing worktree paths     |
| Per-worktree dev server URLs | Yes                                                             | —                           |
| CLI                          | Run, `--host`, ls, send, schedule, loop                         | Launch and control sessions |
| Application plugins          | Server code and native client components                        | No                          |
| Voice                        | Local or configured cloud speech                                | Yes                         |

See also: [Paseo vs Conductor](/alternatives/conductor), [Paseo vs Superset](/alternatives/superset), [Paseo vs OpenChamber](/alternatives/openchamber).
