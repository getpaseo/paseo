<p align="center">
  <img src="packages/website/public/logo.svg" width="64" height="64" alt="Hubcode logo">
</p>

<h1 align="center">Hubcode</h1>

<p align="center">One interface for all your Claude Code, Codex and OpenCode agents.</p>

<p align="center">
  <img src="https://hubcode.ai/hero-mockup.png" alt="Hubcode app screenshot" width="100%">
</p>

<p align="center">
  <img src="https://hubcode.ai/mobile-mockup.png" alt="Hubcode mobile app" width="100%">
</p>

---

Run agents in parallel on your own machines. Ship from your phone or your desk.

- **Self-hosted:** Agents run on your machine with your full dev environment. Use your tools, your configs, and your skills.
- **Multi-provider:** Claude Code, Codex, and OpenCode through the same interface. Pick the right model for each job.
- **Voice control:** Dictate tasks or talk through problems in voice mode. Hands-free when you need it.
- **Cross-device:** iOS, Android, desktop, web, and CLI. Start work at your desk, check in from your phone, script it from the terminal.
- **Privacy-first:** Hubcode doesn't have any telemetry, tracking, or forced log-ins.

## Getting Started

Hubcode runs a local server called the daemon that manages your coding agents. Clients like the desktop app, mobile app, web app, and CLI connect to it.

### Prerequisites

You need at least one agent CLI installed and configured with your credentials:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [Codex](https://github.com/openai/codex)
- [OpenCode](https://github.com/anomalyco/opencode)

### Desktop app (recommended)

Download it from [hubcode.ai/download](https://hubcode.ai/download) or the [GitHub releases page](https://github.com/hubtool/hubcode/releases). Open the app and the daemon starts automatically. Nothing else to install.

To connect from your phone, scan the QR code shown in Settings.

### CLI / headless

Install the CLI and start Hubcode:

```bash
npm install -g @hubcode/cli
hubcode
```

This shows a QR code in the terminal. Connect from any client. This path is useful for servers and remote machines.

For full setup and configuration, see:
- [Docs](https://hubcode.ai/docs)
- [Configuration reference](https://hubcode.ai/docs/configuration)

## CLI

Everything you can do in the app, you can do from the terminal.

```bash
hubcode run --provider claude/opus-4.6 "implement user authentication"
hubcode run --provider codex/gpt-5.4 --worktree feature-x "implement feature X"

hubcode ls                           # list running agents
hubcode attach abc123                # stream live output
hubcode send abc123 "also add tests" # follow-up task

# run on a remote daemon
hubcode --host workstation.local:6767 run "run the full test suite"
```

See the [full CLI reference](https://hubcode.ai/docs/cli) for more.

## Orchestration skills (Unstable)

Experimental skills that teach agents how to use the Hubcode CLI to orchestrate other agents. I am updating these very frequently as I learn new things, expect changes without notice, might be coupled to my own setup, use at your own risk.

```bash
npx skills add hubtool/hubcode
```

Then use them in any agent conversation:

```bash
# Use handoff when you discuss something with an agent but want another one to implement.
# I use this to plan with Claude and then handoff to Codex to implement.
/hubcode-handoff hand off the authentication fix to codex 5.4 in a worktree

# Use loops when you have clear acceptance criteria (aka Ralph loops).
/hubcode-loop loop a codex agent to fix the backend tests, use sonnet to verify, max 10 iterations

# Orchestrator teaches the agent how to create teams and manage them via a chat room.
# Very opinionated and expects both Codex and Claude to work.
/hubcode-orchestrator spin up a team to implement the database refactor, use chat to coordinate. use claude to plan and codex to implement and review
```

## Development

Quick monorepo package map:
- `packages/server`: Hubcode daemon (agent process orchestration, WebSocket API, MCP server)
- `packages/app`: Expo client (iOS, Android, web)
- `packages/cli`: `hubcode` CLI for daemon and agent workflows
- `packages/desktop`: Electron desktop app
- `packages/relay`: Relay package for remote connectivity
- `packages/website`: Marketing site and documentation (`hubcode.ai`)

Common commands:

```bash
# run all local dev services
npm run dev

# run individual surfaces
npm run dev:server
npm run dev:app
npm run dev:desktop

# build the daemon
npm run build:daemon

# repo-wide checks
npm run typecheck
```

## License

AGPL-3.0
