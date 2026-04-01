---
applyTo: "**"
---

# Paseo — Project Overview

Paseo is a **local-first** mobile/desktop/web/CLI app for monitoring and controlling AI coding agents (Claude Code, Codex, OpenCode) from anywhere. Your code stays on your machine; Paseo only orchestrates and streams agent output to clients.

## Core concept

A **daemon** (`packages/server`) runs on the developer's machine. It spawns and manages agent processes and exposes a real-time WebSocket API. Clients (app, CLI, desktop, or another machine via relay) connect to observe and interact with agents.

## Monorepo structure

| Package | Role |
|---|---|
| `packages/server` | **Daemon** — agent lifecycle, WebSocket API, MCP server, relay transport |
| `packages/app` | **Mobile + web client** — Expo (iOS, Android, web) |
| `packages/cli` | **CLI** — Docker-style commands (`paseo run/ls/logs/wait/send/attach`) |
| `packages/relay` | **Relay** — E2E encrypted bridge for remote access behind firewalls |
| `packages/desktop` | **Desktop** — Electron wrapper; auto-manages its own daemon subprocess |
| `packages/website` | **Marketing site** — TanStack Router + Cloudflare Workers (paseo.sh) |

Additional packages: `packages/expo-two-way-audio`, `packages/highlight`.

## Key commands

```bash
npm run dev                    # Start daemon + Expo in Tmux
npm run dev:server             # Daemon only
npm run dev:app                # Expo client only
npm run dev:desktop            # Desktop only
npm run build:daemon           # Build the daemon
npm run typecheck              # ALWAYS run after any change
npm run test                   # Run Vitest suite
npm run format                 # Biome formatter
npm run cli -- ls -a -g        # List all agents
npm run cli -- daemon status   # Check daemon status
```

## Critical rules for AI agents

- **NEVER restart the daemon on port 6767 without permission** — it manages all running agents; restarting kills your own process if you are an agent.
- **NEVER assume a timeout means the service needs restarting** — timeouts can be transient.
- **NEVER add auth checks to tests** — agent providers handle their own auth.
- **Always run `npm run typecheck` after every code change.**
- Daemon logs: `$PASEO_HOME/daemon.log`

## Deployment models

1. **Local** (default): `paseo daemon start` on `127.0.0.1:6767`
2. **Managed desktop**: Electron spawns daemon as a subprocess
3. **Remote + relay**: Daemon behind firewall, relay bridges connections with E2E encryption (ECDH + AES-256-GCM)

## Documentation map

| Doc | Topic |
|---|---|
| `docs/ARCHITECTURE.md` | System design, WebSocket protocol, agent lifecycle, data flow |
| `docs/CODING_STANDARDS.md` | TypeScript patterns, error handling, state design, React patterns |
| `docs/TESTING.md` | TDD workflow, determinism, real-deps-over-mocks philosophy |
| `docs/DEVELOPMENT.md` | Dev setup, build sync gotchas, debugging |
| `docs/DESIGN.md` | Feature design process |
| `SECURITY.md` | Relay threat model, E2E encryption, DNS rebinding |
