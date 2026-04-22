# AGENTS.md — Paseo Server Development Guide

For AI coding agents working in `packages/server`. Supplements [CLAUDE.md](../CLAUDE.md) at the repo root.

## Project Overview

Paseo is a mobile + CLI app for monitoring and controlling local AI coding agents (Claude Code, Codex, OpenCode). The daemon runs on your machine, manages agent processes, and streams their output over WebSocket to clients.

---

## Build / Lint / Test Commands

### Root (monorepo)
```bash
npm run dev                          # Start daemon + Expo in Tmux
npm run build:daemon                 # Build: highlight + relay + server + cli
npm run typecheck                    # Typecheck all packages
npm run test                         # Test all packages
npm run format                       # Format with Biome (in-place)
```

### Server package (`packages/server`)
```bash
npm run dev                          # Start dev daemon (tsx watch)
npm run build                        # Build lib + scripts to dist/
npm run start                        # Run production daemon from dist/
npm run typecheck                    # Typecheck server source

# Run a SINGLE test file
npx vitest run src/server/agent/agent-manager.test.ts --reporter=verbose

# Run a SINGLE test by name
npx vitest run -t "returns timeout error when provider times out"

# Test categories
npm run test:unit                    # Unit tests only (excludes e2e)
npm run test:integration             # Integration tests
npm run test:integration:all         # All integration tests
npm run test:integration:real       # Real API integration tests
npm run test:integration:local       # Local integration tests
npm run test:e2e                     # End-to-end tests (excludes real/local)
npm run test:e2e:all                # All e2e tests
npm run test:watch                  # Watch mode
npm run test:ui                     # Vitest UI at localhost:51204
```

### Other useful commands
```bash
npm run build --workspace=@getpaseo/relay    # Rebuild relay before daemon
npm run build --workspace=@getpaseo/server   # Rebuild server
npm run db:query -- "SELECT ..."             # Run arbitrary SQL
npm run cli -- ls -a -g                      # List agents
npm run cli -- daemon status                 # Check daemon status
```

---

## Code Style

### Biome (formatting only, no linting)
```json
{ "indentStyle": "space", "indentWidth": 2, "lineWidth": 100, "quoteStyle": "double", "trailingCommas": "all", "semicolons": "always" }
```

### TypeScript
- **Fully strict** — no `any`, no implicit `any`
- **`interface`** over `type`** when possible
- **`function` declarations** over arrow function assignments
- **Named types** — no complex inline types in public signatures
- **Object parameters** — use single object param when >1 argument
- **Infer from Zod schemas** — `z.infer<typeof schema>` instead of hand-written types
- `noUnusedLocals: true`, `noUnusedParameters: true`, `noFallthroughCasesInSwitch: true`

### Imports
- Use path alias `@server/*` in server package (maps to `./src/`)
- No barrel `index.ts` re-exports — they create unnecessary indirection

### Naming
- Files: `kebab-case.ts` named after the main export (`create-tool-call.ts`)
- Tests: collocated with implementation (`thing.test.ts`)
- No prefixes like `RpcX`, `DbX`, `UiX` — keep one canonical type per concept

### Error Handling
- **Fail explicitly** — throw instead of silently returning defaults
- **Typed domain errors** — extend `Error` with structured metadata

```typescript
class TimeoutError extends Error {
  constructor(
    public readonly operation: string,
    public readonly waitedMs: number,
  ) {
    super(`${operation} timed out after ${waitedMs}ms`);
    this.name = "TimeoutError";
  }
}
```

### State Design
Discriminated unions over bags of booleans/optionals:
```typescript
// Bad
interface FetchState { isLoading: boolean; error?: Error; data?: Data }

// Good
type FetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "success"; data: Data };
```

---

## Testing Philosophy

Tests prove behavior, not structure. Every test should answer: "what user-visible or API-visible behavior does this verify?"

- **TDD**: Work in vertical slices — one test, one implementation, repeat
- **Determinism first**: No conditional assertions, no timing/randomness, no weak assertions
- **Real deps over mocks**: Database, APIs, file system — real in tests
- **Flaky tests are a bug**: Never remove a test because it's flaky; fix the variance source

---

## Critical Rules

1. **NEVER restart the daemon on port 6767** — it kills your own process
2. **NEVER assume timeouts need a restart** — they can be transient
3. **Always run `npm run typecheck` after changes**
4. **NEVER add auth checks to tests** — agent providers handle their own auth
5. **NEVER make breaking WebSocket/message schema changes** — always backward-compatible

---

## Architecture Quick Reference

```
packages/server/src/
├── server/
│   ├── index.ts              # Entry point
│   ├── bootstrap.ts           # Daemon initialization
│   ├── websocket-server.ts   # WS connection management
│   ├── session.ts             # Per-client session state
│   └── agent/
│       ├── agent-manager.ts  # Agent lifecycle state machine
│       └── agent-storage.ts  # File-backed JSON persistence
├── providers/                 # Claude, Codex, OpenCode adapters
├── relay-transport.ts        # Outbound relay connection
└── client/daemon-client.ts   # Client library for daemon connection
```

Agent state persists to `$PASEO_HOME/agents/{cwd-with-dashes}/{agent-id}.json`  
Daemon logs: `$PASEO_HOME/daemon.log`

---

## Debugging

```bash
tail -f $PASEO_HOME/daemon.log      # Daemon logs
npm run test:ui                     # Vitest browser UI at localhost:51204
npm run cli -- inspect <agent-id>   # Detailed agent info
npm run db:query -- "SELECT * FROM agent_timeline_rows..."
```

---

## Relevant Docs

| File | What it covers |
|---|---|
| [../CLAUDE.md](../CLAUDE.md) | Repository overview, critical rules, quick start |
| [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) | System design, WebSocket protocol, data flow |
| [../docs/CODING_STANDARDS.md](../docs/CODING_STANDARDS.md) | Type hygiene, error handling, React patterns |
| [../docs/TESTING.md](../docs/TESTING.md) | TDD workflow, determinism, real deps over mocks |
| [../SECURITY.md](../SECURITY.md) | Relay threat model, E2E encryption |
