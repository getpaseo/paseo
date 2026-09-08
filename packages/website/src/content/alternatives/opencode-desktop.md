---
title: OpenCode Desktop Alternative With Native Mobile and Multi-Provider Orchestration
description: Paseo is an OpenCode Desktop alternative for developers who want native mobile apps, a self-hosted daemon, and OpenCode alongside Claude Code, Codex, Copilot, and more.
nav: OpenCode Desktop
order: 56
---

# Paseo vs OpenCode Desktop

OpenCode Desktop is the desktop app for OpenCode. It is available in beta for macOS, Windows, and Linux.

Paseo is an app for orchestrating coding agents, with native clients on desktop, mobile, web, and the CLI. Open source (Apache-2.0).

![Paseo desktop and mobile app](/hero-mockup.png)

## The main difference

OpenCode connects many model providers through the OpenCode agent runtime. Paseo runs OpenCode alongside independent Claude Code, Codex, Pi, ACP, and custom agent harnesses.

OpenCode provides terminal, IDE, web, and beta desktop interfaces. Paseo adds native iOS and Android clients, managed worktrees and services, pull-request workflows, and application plugins.

## Architecture

Paseo runs a daemon on your machine. Desktop, web, mobile, and CLI clients connect to it over a websocket. The daemon launches OpenCode and other providers as local processes, using your installed CLIs and credentials.

OpenCode Desktop is the desktop app for OpenCode. OpenCode is available as a terminal interface, desktop app, IDE extension, web surface, and integrations.

## Providers

OpenCode is a multi-model coding agent. It can connect to many LLM providers through its own provider system, including OpenCode Zen, local models, and API providers.

Paseo is multi-provider at the agent harness layer. It runs OpenCode, Claude Code, Codex, and Pi natively, plus 30+ more agents through the in-app catalog including GitHub Copilot, Cursor, Gemini CLI, and Amp. Paseo speaks the [Agent Client Protocol](https://agentclientprotocol.com), so any ACP agent works. Custom providers run any CLI agent. See [all supported providers](/agents).

## Application plugins

[Paseo plugins](/docs/plugins) extend Paseo itself. They can add server behavior and native client components such as workspace panels, sidebar items, composer attachments, themes, and Command Center items across desktop, browser, iOS, and Android.

OpenCode Desktop does not document an application extension API for adding both server behavior and native client components.

## Desktop platforms

Paseo ships on macOS, Linux, and Windows. OpenCode provides beta desktop builds for the same platforms.

## Mobile

Paseo ships native iOS and Android apps with the same agent workflow as the desktop app.

OpenCode Desktop is a desktop app. OpenCode also has web and share-link workflows, but not a native mobile app.

## Panes

Paseo's app has split panes and tabs (⌘D for vertical, ⌘⇧D for horizontal). Panes include agents, terminals, a diff viewer, and a browser for testing running services.

OpenCode is available in terminal, IDE, and desktop surfaces. Its core workflow centers on OpenCode sessions.

## GitHub

Paseo's app handles commit, push, opening PRs, watching checks and reviews, and merging.

OpenCode has GitHub and GitLab integrations, and OpenCode sessions can make and review code changes through its agent workflow.

## CLI and automation

OpenCode has its own terminal interface, CLI, IDE extension, GitHub and GitLab integrations, and share links.

Paseo's CLI controls the same daemon as the app:

```bash
paseo run --provider opencode "implement OAuth"
paseo run --provider claude --worktree refactor-auth "refactor auth"
paseo run --host devbox:6767 "run the test suite"
paseo ls
paseo send <agent-id> "add tests"
paseo schedule create --cron "0 9 * * 1" "audit the codebase"
```

`paseo run --host` connects to a remote daemon. `paseo schedule` runs an agent on a cron. The MCP server lets other agents create worktrees, launch agents, open terminals, and send prompts.

## Worktrees and services

Paseo runs each agent in its own Git worktree. Each worktree gets its own dev server URL like `web.fix-auth.my-app.localhost`, so parallel agents don't fight for ports.

OpenCode supports multi-session work on the same project. If you want worktree isolation around OpenCode sessions, Paseo can provide that by launching OpenCode inside Paseo workspaces.

## Privacy and source

Both tools are open source.

Paseo is Apache-2.0 and runs your agents through a daemon you control. OpenCode is open source and says it does not store your code or context data by default. OpenCode share links are public when you create them.

## Voice

Paseo supports dictation and realtime voice mode. Speech-to-text and text-to-speech can run locally on your device.

## Comparison

|                              | Paseo                                                           | OpenCode Desktop                |
| ---------------------------- | --------------------------------------------------------------- | ------------------------------- |
| License                      | Open source (Apache-2.0)                                        | Open source (MIT)               |
| Desktop platforms            | macOS, Linux, Windows                                           | macOS, Linux, Windows           |
| Native mobile                | iOS, Android                                                    | No                              |
| Agent harnesses              | Claude Code, Codex, OpenCode, Pi + 30+ via ACP catalog + custom | OpenCode                        |
| Multi-model support          | Through supported agent harnesses                               | Through OpenCode providers      |
| Git worktrees                | Yes                                                             | No built-in worktree manager    |
| Per-worktree dev server URLs | Yes                                                             | No                              |
| Split panes and tabs         | Yes                                                             | Desktop sessions                |
| In-app terminal              | Yes                                                             | OpenCode terminal workflow      |
| In-app browser               | Yes                                                             | No                              |
| GitHub workflow in app       | Commit, push, PR, checks, reviews, merge                        | GitHub integration              |
| CLI                          | Run, `--host`, ls, send, schedule, loop                         | OpenCode CLI                    |
| MCP server for orchestration | Yes                                                             | MCP support inside OpenCode     |
| Application plugins          | Server code and native client components                        | No                              |
| Local voice                  | Yes                                                             | No                              |
| Self-hosted daemon           | Yes                                                             | OpenCode server / local runtime |

See also: [Paseo vs Codex App](/alternatives/codex-app), [Paseo vs Claude Desktop](/alternatives/claude-desktop), [Paseo vs OpenChamber](/alternatives/openchamber).
