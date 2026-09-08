---
title: Open Source Claude Desktop Alternative With Native Mobile and Multi-Provider Support
description: Paseo is an open source Claude Desktop alternative that runs on your machines without a required Paseo account, telemetry, or cloud service.
nav: Claude Desktop
order: 55
---

# Paseo vs Claude Desktop

Claude Desktop is Anthropic's app for Claude Chat, Cowork, and Claude Code on macOS, Windows, and Linux.

Paseo is an app for orchestrating coding agents, with native clients on desktop, mobile, web, and the CLI. Open source (Apache-2.0).

![Paseo desktop and mobile app](/hero-mockup.png)

## The main difference

Claude Desktop is Anthropic's first-party interface for Claude and requires a Claude account. It can run Claude Code locally, over SSH, or on Anthropic's infrastructure.

Paseo is an open source control plane that runs on machines you control. It does not require a Paseo account, collect telemetry, or depend on a Paseo cloud service. Connect directly from desktop, mobile, web, or the CLI, or use the optional end-to-end encrypted relay when the daemon is behind a firewall.

Paseo does not upload or store your code. The relay cannot read your code, messages, or agent output. You can also self-host the daemon, web client, and relay.

## Architecture

Paseo runs an independent daemon on your laptop, workstation, VM, home lab, or cloud machine. Its clients connect directly or through the optional end-to-end encrypted relay. The daemon launches your installed providers with their existing credentials, skills, MCP servers, and project configuration.

Claude Desktop is the Anthropic-controlled host application. Claude Code can run locally, connect over SSH, or use Anthropic-managed cloud sessions.

## Providers

Claude Desktop runs Claude Code.

Paseo runs Claude Code too, plus Codex, OpenCode, and Pi natively, plus 30+ more agents through the in-app catalog including GitHub Copilot, Cursor, Gemini CLI, and Amp. Paseo speaks the [Agent Client Protocol](https://agentclientprotocol.com), so any ACP agent works. Custom providers run any CLI agent. See [all supported providers](/agents).

## Application plugins

[Paseo plugins](/docs/plugins) extend Paseo itself. They can add server behavior and native client components such as workspace panels, sidebar items, composer attachments, themes, and Command Center items across desktop, browser, iOS, and Android.

Claude Desktop does not document an application extension API for adding both server behavior and native client components.

## Desktop platforms

Both Claude Desktop and Paseo are available on macOS, Windows, and Linux.

## Mobile

Paseo ships native iOS and Android apps with the same agent workflow as the desktop app.

Claude has iOS and Android apps. Dispatch can start local Claude Code work through an active Claude Desktop host or start a cloud session on Anthropic's infrastructure.

## Panes

Both tools support visual coding workflows around Claude Code.

Paseo's app has split panes and tabs (⌘D for vertical, ⌘⇧D for horizontal). Panes include agents, terminals, a diff viewer, and a browser for testing running services.

Claude Desktop has a graphical Code tab with sessions, integrated terminal, file editor, visual diff review, live app preview, PR monitoring, and scheduled tasks.

## GitHub

Paseo's app handles commit, push, opening PRs, watching checks and reviews, and merging.

Claude Desktop can monitor pull request status and can fix failures or merge when checks pass, depending on the workflow and permissions.

## CLI and automation

Claude Code has its own CLI, IDE integrations, web surface, scheduled tasks, and cloud sessions.

Paseo's CLI controls the same daemon as the app:

```bash
paseo run --provider claude "implement OAuth"
paseo run --provider codex --worktree refactor-auth "refactor auth"
paseo run --host devbox:6767 "run the test suite"
paseo ls
paseo send <agent-id> "add tests"
paseo schedule create --cron "0 9 * * 1" "audit the codebase"
```

`paseo run --host` connects to a remote daemon. `paseo schedule` runs an agent on a cron. The MCP server lets other agents create worktrees, launch agents, open terminals, and send prompts.

## Worktrees and services

Both tools support parallel coding sessions, including Git worktrees.

Paseo also gives each worktree its own dev server URL. Two agents running their dev servers at the same time get `web.fix-auth.my-app.localhost` and `web.add-search.my-app.localhost` instead of port collisions.

## Voice

Paseo supports dictation and realtime voice mode. Speech-to-text and text-to-speech can run locally on your device.

Claude supports voice in Claude's own mobile and app surfaces. Claude Code itself is available in Claude Desktop, terminal, IDE, web, and mobile Remote Control workflows.

## Comparison

|                              | Paseo                                                           | Claude Desktop                       |
| ---------------------------- | --------------------------------------------------------------- | ------------------------------------ |
| License                      | Open source (Apache-2.0)                                        | Not published as open source         |
| Desktop platforms            | macOS, Linux, Windows                                           | macOS, Linux, Windows                |
| Mobile coding workflow       | Native Paseo workspace on iOS and Android                       | Dispatch and Cowork in Claude mobile |
| Coding agents                | Claude Code, Codex, OpenCode, Pi + 30+ via ACP catalog + custom | Claude Code                          |
| Product account required     | No                                                              | Claude account                       |
| Cloud agent                  | Cloud waitlist                                                  | Claude Cowork and remote sessions    |
| Required cloud connection    | No                                                              | Claude account and services          |
| Machines you control         | Laptop, workstation, VM, server, or home lab                    | Local machine or SSH host            |
| Git worktrees                | Yes                                                             | Yes                                  |
| Per-worktree dev server URLs | Yes                                                             | No                                   |
| Split panes and tabs         | Yes                                                             | Yes                                  |
| In-app terminal              | Yes                                                             | Yes                                  |
| In-app browser / preview     | Yes                                                             | Yes                                  |
| GitHub workflow in app       | Commit, push, PR, checks, reviews, merge                        | PR monitoring and merge workflows    |
| CLI                          | Run, `--host`, ls, send, schedule, loop                         | Claude Code CLI                      |
| Remote transport             | Direct connection or end-to-end encrypted relay                 | Anthropic Remote and cloud services  |
| Application plugins          | Server code and native client components                        | No                                   |
| Self-hosted control plane    | Daemon, web client, and relay                                   | No                                   |

See also: [Paseo vs Codex App](/alternatives/codex-app), [Paseo vs OpenCode Desktop](/alternatives/opencode-desktop), [Paseo vs Conductor](/alternatives/conductor).
