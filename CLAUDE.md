# CLAUDE.md

Paseo is a mobile app for monitoring and controlling your local AI coding agents from anywhere. Your dev environment, in your pocket. Connects directly to your actual development environment — your code stays on your machine.

**Supported agents:** Claude Code, Codex, and OpenCode.

## Repository map

This is an npm workspace monorepo:

- `packages/server` — Daemon: agent lifecycle, WebSocket API, MCP server
- `packages/app` — Mobile + web client (Expo)
- `packages/cli` — Docker-style CLI (`paseo run/ls/logs/wait`)
- `packages/relay` — E2E encrypted relay for remote access
- `packages/desktop` — Electron desktop wrapper
- `packages/website` — Marketing site (paseo.sh)

## Documentation

| Doc | What's in it |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, package layering, WebSocket protocol, agent lifecycle, data flow |
| [docs/CODING_STANDARDS.md](docs/CODING_STANDARDS.md) | Type hygiene, error handling, state design, React patterns, file organization |
| [docs/TESTING.md](docs/TESTING.md) | TDD workflow, determinism, real dependencies over mocks, test organization |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Dev server, build sync gotchas, CLI reference, agent state, Playwright MCP |
| [docs/RELEASE.md](docs/RELEASE.md) | Release playbook, draft releases, completion checklist |
| [docs/ANDROID.md](docs/ANDROID.md) | App variants, local/cloud builds, EAS workflows |
| [docs/DESIGN.md](docs/DESIGN.md) | How to design features before implementation |
| [SECURITY.md](SECURITY.md) | Relay threat model, E2E encryption, DNS rebinding, agent auth |

## Quick start

```bash
npm run dev                          # Start daemon + Expo in Tmux
npm run cli -- ls -a -g              # List all agents
npm run cli -- daemon status         # Check daemon status
npm run typecheck                    # Always run after changes
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for full setup, build sync requirements, and debugging.

## Critical rules

- **NEVER restart the main Paseo daemon on port 6767 without permission** — it manages all running agents. If you're an agent, restarting it kills your own process.
- **NEVER assume a timeout means the service needs restarting** — timeouts can be transient.
- **NEVER add auth checks to tests** — agent providers handle their own auth.
- **Always run typecheck after every change.**
- **NEVER make breaking changes to WebSocket or message schemas.** The primary compatibility path is old mobile app clients talking to newly updated daemons. Users update desktop and daemon first, then keep running the old app for a while. Every schema change MUST be backward-compatible for old clients against new daemons:
  - New fields: always `.optional()` with a sensible default or `.transform()` fallback.
  - Never change a field from optional to required.
  - Never remove a field — deprecate it (keep accepting it, stop sending it).
  - Never narrow a field's type (e.g. `string` → `enum`, `nullable` → non-null).
  - Test with: "does a 6-month-old client still parse this?" and "does a 6-month-old daemon still send something this client accepts?"

## Debugging


Find the complete daemon logs and traces in the $PASEO_HOME/daemon.log
