---
title: Open Source Superset Alternative With Native Mobile
description: Paseo is an Apache-2.0 Superset alternative that runs locally without an account and supports application plugins across its server and clients.
nav: Superset
order: 51
---

# Paseo vs Superset

Superset is a source-available desktop workspace for running CLI coding agents in parallel Git worktrees. It includes a CLI, SDK, MCP server, and remote hosts.

Paseo orchestrates coding agents from desktop, mobile, web, and the CLI. Open source under Apache-2.0.

![Paseo desktop and mobile app](/hero-mockup.png)

## The main difference

Superset provides a terminal-centered workspace for running many CLI agents in parallel Git worktrees. It requires a Superset account and GitHub sign-in, and its source is published under the Elastic License 2.0.

Paseo runs locally without an account, is licensed under Apache 2.0, provides structured interfaces for supported agent harnesses, and supports application plugins with server-side behavior and native client components.

## License

Paseo is open source under Apache-2.0. You can audit, fork, modify, and redistribute it.

Superset publishes its source under the Elastic License 2.0. You can use and modify it, but the license restricts offering Superset as a managed service and bypassing license-protected functionality.

## Architecture and access

Both tools run agents on machines you control and can connect to remote hosts.

Paseo's daemon runs independently of its clients. Desktop, web, mobile, CLI, SDK, and MCP clients can connect directly, and local use does not require an account.

Superset requires a Superset account and GitHub sign-in when opening the app. Its synchronization, remote access, and team workflows use Superset's cloud services.

## Providers

Superset supports many CLI-based coding agents and lets you add custom terminal agents.

Paseo runs Claude Code, Codex, OpenCode, Pi, Antigravity, and Muse Code through native structured harnesses, plus 30+ agents through its ACP catalog and any custom CLI agent. See [all supported providers](/agents).

## Application plugins

[Paseo plugins](/docs/plugins) extend Paseo itself. They can add server behavior and native client components such as workspace panels, sidebar items, composer attachments, themes, and Command Center items across desktop, browser, iOS, and Android.

Superset does not document an application extension API for adding both server behavior and native client components.

## Workspaces and review

Both tools provide Git worktrees, split panes, terminals, diff review, an in-app browser, GitHub workflows, schedules, and remote hosts.

Paseo gives supported providers a structured chat interface with modes, slash commands, tool calls, and file attachments. Superset can run any CLI agent in terminal panes and adds lifecycle status for supported agents.

Paseo also gives each worktree its own service URL, such as `web--fix-auth--my-app.localhost`, so parallel development servers do not compete for ports.

## Automation

Both tools expose workspace and agent operations through a CLI, TypeScript SDK, and MCP server. They can create workspaces, launch agents, follow progress, and manage scheduled work.

## Pricing

Paseo is free with no seat limits.

Superset has a free individual tier. Team features, remote access, and integrations are part of its paid plans.

## Comparison

|                              | Paseo                                                                                              | Superset                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| License                      | Open source (Apache-2.0)                                                                           | Source-available (Elastic License 2.0)                                |
| Account required             | No                                                                                                 | Yes, with GitHub sign-in                                              |
| Desktop app                  | Yes (one click install, daemon bundled)                                                            | Yes (macOS, experimental Linux)                                       |
| Mobile app                   | Yes (native, full parity with desktop)                                                             | Coming soon                                                           |
| CLI                          | Yes (everything the app does)                                                                      | Yes (plus SDK and MCP server)                                         |
| Remote machines              | Yes (install the daemon anywhere)                                                                  | Yes (host server, remote access through Superset cloud on paid plans) |
| Built-in relay               | Yes (opt-in, end-to-end encrypted, no account)                                                     | Superset cloud services (paid plans)                                  |
| Direct network access        | Yes (LAN, Tailscale, VPN)                                                                          | -                                                                     |
| SSH access                   | Yes                                                                                                | -                                                                     |
| Providers                    | Claude Code, Codex, OpenCode, Pi, Antigravity, Muse Code, 30+ more                                 | CLI agents, custom terminal agents                                    |
| Parallel agents              | Yes (isolated worktrees, across machines)                                                          | Yes (Git worktrees)                                                   |
| Terminal agents              | Yes (run any agent in a terminal, get notified when it finishes)                                   | Yes (lifecycle status for supported agents)                           |
| Agent orchestration          | Yes (agents create worktrees and launch other agents, across providers)                            | Yes (CLI, SDK, and MCP server create workspaces and launch agents)    |
| Editor                       | Yes                                                                                                | -                                                                     |
| Terminals                    | Yes                                                                                                | Yes                                                                   |
| Diff review                  | Yes (comments go to the agent)                                                                     | Yes                                                                   |
| Pull requests in app         | GitHub, GitLab, Gitea, Forgejo, Codeberg                                                           | GitHub                                                                |
| In-app browser               | Yes (element picker, agent browser tools)                                                          | Yes                                                                   |
| Per-worktree dev server URLs | Yes (`web--fix-auth--my-app.localhost`)                                                            | Port detection                                                        |
| Schedules and heartbeats     | Yes                                                                                                | Yes (schedules)                                                       |
| Plan usage                   | Yes                                                                                                | -                                                                     |
| Plugins                      | Yes (new screens, panels, agent hooks, and providers, one plugin runs on desktop, web, and mobile) | No                                                                    |
| Voice                        | Yes (local dictation, realtime voice)                                                              | -                                                                     |
| Telemetry                    | None                                                                                               | -                                                                     |

See also: [Paseo vs Conductor](/alternatives/conductor), [Paseo vs OpenChamber](/alternatives/openchamber), [Paseo vs Happy Coder](/alternatives/happy-coder).
