# Product

What Paseo is, who it's for, and where it's going.

## What is Paseo

Paseo is a next-generation development environment built around agents. One interface to run, monitor, and interact with coding agents across desktop, mobile, terminal, and web.

The development workflow is shifting from manually editing files to orchestrating agents that do the editing. Paseo is built for that workflow.

## Core philosophy

Freedom and flexibility. Every design decision follows from this:

- **Multi-provider** — Use any coding agent harness. Pick the right model for each job, switch freely as the landscape shifts. No vendor-lock in.
- **Cross-device** — Desktop, mobile, web, CLI. Start work at your desk, check progress from your phone, script from the terminal.
- **Self-hosted** — The daemon runs on your machine. Your code, your keys, your environment. No inference markup, no cloud dependency.
- **Respectful** - No telemetry, no forced cloud, no forced accounts
- **Open source** — AGPL-3.0. Users can inspect, fork, and contribute.
- **BYOK** — Bring your own keys. Use your subsidized plans and first-party provider pricing. Paseo adds zero cost on top.

## How it works

### Projects and workspaces

Projects are grouped in the sidebar, detected automatically from your filesystem and tagged by git remote when available.

Each project opens as a workspace. For git projects, the default workspace is the main checkout. Users can create additional workspaces, which are isolated copies (git worktrees) where agents work without affecting main.

### Inside a workspace

A workspace is a flexible canvas:

- Launch multiple agents side by side in split panes
- Open terminals alongside agents
- Mix and match providers within the same workspace

### The daemon

Paseo is a client-server system. The daemon (Node.js) runs on your machine, manages agent processes, and streams output in real time over WebSocket. Clients connect to the daemon — locally or remotely.

This architecture means:

- The daemon can run on any machine: laptop, VM, remote server
- Multiple clients can connect simultaneously
- Agents keep running when you close the app

## Target user

Anyone who builds software:

- Care about owning their tools and their data
- Use multiple AI providers and want to switch freely
- Run agents on real tasks across real projects
- Want to work from multiple devices

## What compounds over time

- **Trust** — Showing up daily, shipping in public, being open source. Earned slowly, lost quickly.
- **Community contributions** — Code, packaging, skills, agent configs. Contributors become advocates.
- **Ecosystem** — Skills, integrations, shared configs. Community-built content that makes the platform more valuable.

## Strategic bets

1. **Models commoditize.** Value moves to the orchestration layer. The best model changes monthly — the workflow layer stays.
2. **Multi-provider wins.** No single provider stays on top. Developers want the best model for each task.
3. **The daemon as infrastructure.** Server/client architecture enables deployment anywhere.
4. **Open source outlasts funding.** Open source communities are resilient. Contributors become advocates.

## Current state (May 2026)

- Desktop (Electron), mobile (iOS/Android), web, CLI
- Built-in providers: Claude Code (Agent SDK), Codex (app-server), GitHub Copilot (ACP), OpenCode, Pi
- One-click ACP provider catalog: Cursor, Hermes, Qwen Coder, Kimi Code, and others — plus custom ACP providers
- Voice mode: dictate prompts or talk through problems hands-free
- MCP server exposes the daemon to other agents (create_agent, send_agent_prompt, schedules, terminals, worktrees)
- Scheduled agents (cron-style triggers) via app, CLI, and MCP
- Frequent releases (multiple per week)
- Community contributions across packaging, providers, and bug fixes
- Key UX: split panes, keybinding customization, workspace model, in-app browser
