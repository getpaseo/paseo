# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Paseo is a mobile app for monitoring and controlling your local AI coding agents from anywhere. Your dev environment, in your pocket.

**Key features:**
- Real-time streaming of agent output
- Voice commands for hands-free interaction
- Push notifications when tasks complete
- Multi-agent orchestration across projects

**Not a cloud sandbox** - Paseo connects directly to your actual development environment. Your code stays on your machine.

**Supported agents:** Claude Code, Codex, and OpenCode.

## Monorepo Structure

This is an npm workspace monorepo:

- **packages/server**: The Paseo daemon that runs on your machine. Manages agent processes, provides WebSocket API for real-time streaming, and exposes an MCP server for agent control.
- **packages/app**: Cross-platform client (Expo). Connects to one or more servers, displays agent output, handles voice input, and sends push notifications.
- **packages/cli**: The `paseo` CLI that is used to manage the deamon, and acts as a client to it with  Docker-style commands like `paseo run/ls/logs/wait`
- **packages/website**: Marketing site at paseo.dev (TanStack Router + Cloudflare Workers).

## Development Server

The `npm run dev` script automatically picks an available port for the development server.

When running in a worktree or alongside the main checkout, set `PASEO_HOME` to isolate state:

```bash
PASEO_HOME=~/.paseo-blue npm run dev
```

- `PASEO_HOME` – path for runtime state (agent data, sockets, etc.). Defaults to `~/.paseo`; set this to a unique directory when running a secondary server instance.

## Running and checking logs

Both the server and Expo app are running in a Tmux session. See CLAUDE.local.md for system-specific session details.

## Debugging

### Daemon and CLI

The Paseo daemon communicates via WebSocket. In the main checkout:
- Daemon runs at `localhost:6767`
- Expo app at `localhost:8081`
- State lives in `$PASEO_HOME`

In worktrees or when running `npm run dev`, ports and home directories may differ. Never assume the defaults.

Use `npm run cli` to run the local CLI (instead of the globally linked `paseo` which points to the main checkout). Always run `npm run cli -- --help` or load the `/paseo` skill before using it - do not guess commands.

Use `--host <host:port>` to point the CLI at a different daemon (e.g., `--host localhost:7777`).

### Quick reference CLI commands

```bash
npm run cli -- ls -a -g              # List all agents globally
npm run cli -- ls -a -g --json       # Same, as JSON
npm run cli -- inspect <id>          # Show detailed agent info
npm run cli -- logs <id>             # View agent timeline
npm run cli -- daemon status         # Check daemon status
```

### Agent state

Agent data is stored at:
```
$PASEO_HOME/agents/{cwd-with-dashes}/{agent-id}.json
```

To find an agent by ID:
```bash
find $PASEO_HOME/agents -name "{agent-id}.json"
```

To find an agent by title or other content:
```bash
rg -l "some title text" $PASEO_HOME/agents/
rg -l "spiteful-toad" $PASEO_HOME/agents/
```

### Provider session files

Get the session ID from the agent JSON file (`persistence.sessionId`), then:

**Claude sessions:**
```
~/.claude/projects/{cwd-with-dashes}/{session-id}.jsonl
```

**Codex sessions:**
```
~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-{timestamp}-{session-id}.jsonl
```

## Android

Take screenshots like this: `adb exec-out screencap -p > screenshot.png`

## Expo troubleshooting

Run `npx expo-doctor` to diagnose version mismatches and native module issues.

## Orchestrator Mode

- **When agent control tool calls fail**, make sure you list agents before trying to launch another one. It could just be a wait timeout.
- **Always prefix agent titles** so we can tell which ones are running under you (e.g., "🎭 Feature Implementation", "🎭 Design Discussion").
- **Launch agents in the most permissive mode**: Use full access or bypass permissions mode.
- **Set cwd to the repository root** - The agent's working directory should usually be the repo root

**CRITICAL: ALWAYS RUN TYPECHECK AFTER EVERY CHANGE.**

## Agent Authentication

All agent providers (Claude, Codex, OpenCode) handle their own authentication outside of environment variables. They are authenticated without providing any extra configuration—Paseo does not manage API keys or tokens for agents.

**Do not add auth checks to tests.** If auth fails for whatever reason, let the user know instead of patching the code or adding conditional skips.

## NEVER DO THESE THINGS

- **NEVER restart the main Paseo daemon on port 6767 without permission** - This is the production daemon that launches and manages agents. If you are reading this, you are probably running as an agent under it. Restarting it will kill your own process and all other running agents. The daemon is managed by the user in Tmux.
- **NEVER assume a timeout means the service needs restarting** - Timeouts can be transient network issues, not service failures
- **NEVER add authentication checks to tests** - Agent providers handle their own auth. If tests fail due to auth issues, report it rather than adding conditional skips or env var checks
