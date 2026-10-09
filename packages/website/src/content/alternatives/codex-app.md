---
title: Open Source Codex App Alternative With Native Mobile and Multi-Provider Support
description: Paseo is an open source Codex alternative that runs on your machines without a required Paseo account, telemetry, or cloud service.
nav: Codex App
order: 54
---

# Paseo vs Codex App

OpenAI provides Codex through the ChatGPT desktop app on macOS, Windows, and Linux, with local, worktree, cloud, and remote workflows.

Paseo is an open source agentic development environment. Run parallel agents in separate worktrees, edit files, review diffs and pull requests, and test your app with terminals and a built-in desktop browser. Available on desktop, mobile, web, and CLI under Apache-2.0.

![Paseo desktop and mobile app](/hero-mockup.png)

## The main difference

OpenAI provides Codex through the ChatGPT desktop and mobile apps. Using those product surfaces requires an OpenAI account, and cloud work runs on OpenAI-managed infrastructure.

Paseo runs your installed Codex CLI on machines you control. It does not require a Paseo account, collect telemetry, or depend on a Paseo cloud service. Connect directly from desktop, mobile, web, or the CLI, or use the optional end-to-end encrypted relay.

Paseo does not upload or store your code. The relay cannot read your code, messages, or agent output. You can self-host the daemon, web client, and relay, and use the same control plane with Codex, Claude Code, OpenCode, Pi, ACP agents, and custom providers.

## Architecture

Paseo runs an independent daemon on your laptop, workstation, VM, home lab, or cloud machine. The daemon launches your installed Codex CLI with its existing credentials and configuration. Clients connect directly or through the optional end-to-end encrypted relay.

OpenAI provides local, worktree, remote, and cloud Codex workflows through its ChatGPT product surfaces. Local and remote work use a connected host, while cloud work runs on OpenAI-managed infrastructure.

## Providers

Codex App runs Codex.

Paseo runs Codex too, plus Claude Code, OpenCode, Pi, Antigravity, and Muse Code natively, plus 30+ more agents through the in-app catalog including GitHub Copilot, Cursor, Gemini CLI, and Amp. Paseo speaks the [Agent Client Protocol](https://agentclientprotocol.com), so any ACP agent works. Custom providers run any CLI agent. See [all supported providers](/agents).

## Application plugins

[Paseo plugins](/docs/plugins) extend Paseo itself. They can add server behavior and native client components such as workspace panels, sidebar items, composer attachments, themes, and Command Center items across desktop, browser, iOS, and Android.

Codex supports skills, MCP servers, and other agent extensions. OpenAI does not document an extension API for adding server-side behavior and native interface components to the Codex application itself.

## Desktop platforms

OpenAI's desktop app and Paseo are available on macOS, Windows, and Linux.

## Mobile

The mobile app is the full app, native on iOS and Android, with full feature parity with desktop.

ChatGPT Remote can start and continue Codex chats, approve actions, and review outputs from iOS and Android through a connected desktop host.

## Worktrees and local setup

Both tools support Git worktrees for parallel work.

Codex App creates Codex-managed worktrees under `$CODEX_HOME/worktrees` and supports local environment setup scripts and project actions through `.codex` configuration.

Paseo creates worktrees under `$PASEO_HOME/worktrees`, runs setup and teardown hooks from `paseo.json`, and gives each worktree its own dev server URLs like `web--fix-auth--my-app.localhost` so parallel services don't fight for ports.

## GitHub and review

Both tools support reviewing diffs, committing, pushing, and opening pull requests from the app.

Paseo also surfaces PR checks and reviews in the app, and exposes the same workflow through the CLI and MCP server.

## CLI and automation

Codex has its own CLI, IDE extension, web app, automations, and SDK.

Paseo's CLI controls the same daemon as the app:

```bash
paseo run --provider codex "implement OAuth"
paseo run --provider claude --worktree refactor-auth "refactor auth"
paseo run --host devbox:6767 "run the test suite"
paseo ls
paseo send <agent-id> "add tests"
paseo schedule create --cron "0 9 * * 1" "audit the codebase"
```

`paseo run --host` connects to a remote daemon. `paseo schedule` runs an agent on a cron. The MCP server lets other agents create worktrees, launch agents, open terminals, and send prompts.

## Voice

Codex App supports voice dictation.

Paseo supports dictation and realtime voice mode. Speech-to-text and text-to-speech can run locally on your device.

## Comparison

|                              | Paseo                                                                                              | Codex App                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| License                      | Open source (Apache-2.0)                                                                           | Codex CLI is open source; application is proprietary |
| Account required             | No                                                                                                 | OpenAI account                                       |
| Desktop app                  | Yes (one click install, daemon bundled)                                                            | Yes (macOS, Linux, Windows)                          |
| Mobile app                   | Yes (native, full parity with desktop)                                                             | ChatGPT app (Remote)                                 |
| CLI                          | Yes (everything the app does)                                                                      | Yes (Codex CLI)                                      |
| Remote machines              | Yes (install the daemon anywhere)                                                                  | Yes (connected host, OpenAI-managed cloud)           |
| Built-in relay               | Yes (opt-in, end-to-end encrypted, no account)                                                     | OpenAI Remote                                        |
| Direct network access        | Yes (LAN, Tailscale, VPN)                                                                          | -                                                    |
| SSH access                   | Yes                                                                                                | -                                                    |
| Providers                    | Claude Code, Codex, OpenCode, Pi, Antigravity, Muse Code, 30+ more                                 | Codex                                                |
| Parallel agents              | Yes (isolated worktrees, across machines)                                                          | Yes (Git worktrees)                                  |
| Terminal agents              | Yes (run any agent in a terminal, get notified when it finishes)                                   | -                                                    |
| Agent orchestration          | Yes (agents create worktrees and launch other agents, across providers)                            | -                                                    |
| Editor                       | Yes                                                                                                | -                                                    |
| Terminals                    | Yes                                                                                                | Yes                                                  |
| Diff review                  | Yes (comments go to the agent)                                                                     | Yes                                                  |
| Pull requests in app         | GitHub, GitLab, Gitea, Forgejo, Codeberg                                                           | Commit, push, PR                                     |
| In-app browser               | Yes (element picker, agent browser tools)                                                          | Yes                                                  |
| Per-worktree dev server URLs | Yes (`web--fix-auth--my-app.localhost`)                                                            | No                                                   |
| Schedules and heartbeats     | Yes                                                                                                | -                                                    |
| Plan usage                   | Yes                                                                                                | -                                                    |
| Plugins                      | Yes (new screens, panels, agent hooks, and providers, one plugin runs on desktop, web, and mobile) | No                                                   |
| Voice                        | Yes (local dictation, realtime voice)                                                              | Dictation                                            |
| Telemetry                    | None                                                                                               | -                                                    |

See also: [Paseo vs Claude Desktop](/alternatives/claude-desktop), [Paseo vs OpenCode Desktop](/alternatives/opencode-desktop), [all supported providers](/agents).
