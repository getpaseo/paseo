---
title: Orca ADE Alternative With Agent Chat, a No-Account Relay, and Plugins
description: Paseo is an Orca alternative for developers who want a chat-first interface, a daemon they can reach from any client, and plugins that run on the server and every client.
nav: Orca
order: 57
---

# Paseo vs Orca

Orca is an MIT-licensed desktop app for running terminal coding agents in parallel Git worktrees. It includes a mobile companion app, SSH worktrees, remote Orca servers, an embedded browser, and a CLI.

Paseo is an app for orchestrating coding agents, with native clients on desktop, mobile, web, and the CLI. Open source (Apache-2.0).

![Paseo desktop and mobile app](/hero-mockup.png)

## The main difference

Orca is built around terminals. Each agent runs in a terminal pane, and an experimental Chat UI can show supported agents as a chat transcript. Orca ships a broad set of built-in tools around those terminals.

Paseo is built around agent chat. The app ships what every developer uses: editor, terminals, diffs, pull requests, and a browser. Features only some teams need, like issue boards or cloud VMs, are plugins you install, so nothing you do not use is in the way.

Orca is made by Stably AI, a venture-funded company (Y Combinator). Paseo is independent and open source.

## Architecture and remote machines

The Paseo daemon runs as its own process. Desktop, web, mobile, and CLI clients connect to it directly, over SSH, or through the optional end-to-end encrypted relay. Run the daemon on your laptop, a VM, a home server, or in Docker, and connect to any of them from any client. See [connectivity](/docs/connectivity).

Orca runs inside its desktop app by default and reaches other machines in two ways. SSH worktrees keep the Orca runtime on your laptop and run selected worktrees and terminals on a remote host. Remote Orca Servers, in beta, run Orca desktop or `orca serve` on another machine and let clients pair to it. Orca's documentation recommends Tailscale or another private network for Remote Orca Servers.

## Mobile and the relay

Both tools have iOS and Android apps.

The mobile app is the full app, native on iOS and Android, with full feature parity with desktop. They are on the App Store and Google Play. To connect from your phone, enable the relay and scan a QR code. The daemon connects outbound to the relay and your phone meets it there, so you do not need a VPN, port forwarding, SSH, or an account. Traffic is end-to-end encrypted, and the [relay server](https://github.com/getpaseo/paseo-relay) is open source. You can also connect directly over Tailscale.

Orca's mobile companion is in beta, on the App Store for iOS and as an APK download for Android. It can reply to agents, open sessions as a terminal or Chat UI, commit changes, and create workspaces on the paired desktop. Orca Relay, also in beta, connects the phone when it is not on the same network as the desktop and requires signing in to an Orca account. Without Orca Relay, the phone needs a LAN or Tailscale path to the desktop.

## Chat

Paseo's main interface is a chat with the agent on desktop, web, and mobile. Paseo runs supported providers through structured harnesses, so messages, tool calls, permission requests, modes, slash commands, and file attachments come from the agent's own protocol.

Orca's main interface is the agent's terminal. Its Chat UI is an experimental view over the same terminal session and is turned on under **Settings → Experimental**. It decodes transcripts for Claude, Codex, Grok, and OMP, and the terminal remains the source of truth.

## Providers

Orca runs any CLI agent in a terminal and lists more than 30 supported agents.

Paseo runs Claude Code, Codex, OpenCode, Pi, Antigravity, and Muse Code through native structured harnesses, plus 30+ agents through its ACP catalog and any custom CLI agent. See [all supported providers](/agents).

## Application plugins

[Paseo plugins](/docs/plugins) extend Paseo itself. A plugin can add workspace panels, sidebar items, Command Center items, slash commands, composer pills, settings screens, themes, attachment sources, and agent providers. Its server code runs beside the daemon, and its client code runs in every connected client: desktop, browser, iOS, and Android.

Community plugins are listed at [paseo.sh/plugins](/plugins).

Orca has an experimental plugin system that is off by default. Orca plugins can add desktop panels rendered in a sandboxed frame, commands, keybindings, language packs, VM recipes, and agent profiles, and can be installed from git marketplaces. Plugin workers run on the desktop computer, and Orca does not document plugin surfaces in its mobile app.

## Scope

Orca includes many tools in the core app: a Monaco code editor, Design Mode for sending page elements from its browser to an agent, computer use, Linear and Jira boards, agent account switching with usage tracking, and per-workspace cloud VM recipes. If you want these in one app without extensions, Orca provides them.

Paseo includes an editor, terminals, diff review with comments that go to the agent, pull requests on GitHub, GitLab, Gitea, Forgejo, and Codeberg, a browser with an element picker and agent browser tools, plan usage, schedules, and heartbeats. Boards and cloud VMs are what a plugin adds.

## Workspaces and review

Both tools provide Git worktrees, split panes, terminals, diff review, an in-app browser, pull-request workflows, and scheduled agent runs.

Paseo has diff review with comments that go to the agent and opens pull requests on GitHub, GitLab, Gitea, Forgejo, and Codeberg. It also gives each worktree its own service URL, such as `web--fix-auth--my-app.localhost`, so parallel development servers do not compete for ports. Orca has port forwarding for SSH worktrees and pull requests on GitLab, Bitbucket, Azure DevOps, and Gitea as well as GitHub.

## Automation

Paseo exposes workspace and agent operations through its CLI, TypeScript SDK, and MCP server:

```bash
paseo run --provider codex "implement OAuth"
paseo --host ssh://user@devbox run --cwd /srv/app "run the test suite"
paseo ls
paseo send <agent-id> "add tests"
paseo schedule create --cron "0 9 * * 1" "audit the codebase"
```

Orca's CLI creates worktrees, drives its browser, and manages automations. Orca installs skills so agents can call the same commands.

## Accounts and telemetry

Paseo does not require an account and does not collect telemetry.

Orca does not require an account for local use. Orca Relay and shared artifacts require an Orca account. Packaged Orca builds send anonymous usage telemetry, which you can turn off.

## Comparison

|                              | Paseo                                                                                              | Orca                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| License                      | Open source (Apache-2.0)                                                                           | Open source (MIT)                                       |
| Account required             | No                                                                                                 | No for local use, Orca account for relay                |
| Desktop app                  | Yes (one click install, daemon bundled)                                                            | Yes (macOS, Linux, Windows)                             |
| Mobile app                   | Yes (native, full parity with desktop)                                                             | Yes (companion app, beta)                               |
| CLI                          | Yes (everything the app does)                                                                      | Yes (worktrees, browser, automations)                   |
| Remote machines              | Yes (install the daemon anywhere)                                                                  | Yes (SSH worktrees, Remote Orca Server in beta)         |
| Built-in relay               | Yes (opt-in, end-to-end encrypted, no account)                                                     | Yes (beta, Orca account required)                       |
| Direct network access        | Yes (LAN, Tailscale, VPN)                                                                          | Yes (LAN, Tailscale)                                    |
| SSH access                   | Yes                                                                                                | Yes (SSH worktrees)                                     |
| Providers                    | Claude Code, Codex, OpenCode, Pi, Antigravity, Muse Code, 30+ more                                 | Any CLI agent in a terminal, 30+ listed                 |
| Parallel agents              | Yes (isolated worktrees, across machines)                                                          | Yes (Git worktrees)                                     |
| Terminal agents              | Yes (run any agent in a terminal, get notified when it finishes)                                   | Yes (main interface, experimental Chat UI)              |
| Agent orchestration          | Yes (agents create worktrees and launch other agents, across providers)                            | Yes (agents call the Orca CLI through installed skills) |
| Editor                       | Yes                                                                                                | Yes (Monaco)                                            |
| Terminals                    | Yes                                                                                                | Yes                                                     |
| Diff review                  | Yes (comments go to the agent)                                                                     | Yes                                                     |
| Pull requests in app         | GitHub, GitLab, Gitea, Forgejo, Codeberg                                                           | GitHub, GitLab, Bitbucket, Azure DevOps, Gitea          |
| In-app browser               | Yes (element picker, agent browser tools)                                                          | Yes (Design Mode)                                       |
| Per-worktree dev server URLs | Yes (`web--fix-auth--my-app.localhost`)                                                            | Port forwarding for SSH worktrees                       |
| Schedules and heartbeats     | Yes                                                                                                | Yes (scheduled agent runs)                              |
| Plan usage                   | Yes                                                                                                | Yes (usage tracking, account switching)                 |
| Plugins                      | Yes (new screens, panels, agent hooks, and providers, one plugin runs on desktop, web, and mobile) | Experimental, desktop only                              |
| Voice                        | Yes (local dictation, realtime voice)                                                              | Dictation                                               |
| Telemetry                    | None                                                                                               | Anonymous usage data, opt-out                           |

See also: [Paseo vs Conductor](/alternatives/conductor), [Paseo vs Superset](/alternatives/superset), [Paseo vs OpenChamber](/alternatives/openchamber).
