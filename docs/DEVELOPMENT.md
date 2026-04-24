# Development

## Prerequisites

- Node.js (see `.tool-versions` for exact version)
- npm workspaces (comes with Node)

## Running the dev server

```bash
npm run dev
```

The dev script automatically picks an available port. Both the server and Expo app run in a Tmux session — see `CLAUDE.local.md` for system-specific session details.

### Running alongside the main checkout

Set `HUBCODE_HOME` to isolate state when running a second instance (e.g., in a worktree):

```bash
HUBCODE_HOME=~/.hubcode-blue npm run dev
```

- `HUBCODE_HOME` — path for runtime state (agents, sockets, etc.). Defaults to `~/.hubcode`.

### Default ports

In the main checkout:
- Daemon: `localhost:6767`
- Expo app: `localhost:8081`

In worktrees or with `npm run dev`, ports may differ. Never assume defaults.

### Daemon logs

Check `$HUBCODE_HOME/daemon.log` for trace-level logs.

## Build sync gotchas

### Relay → Daemon

When changing `packages/relay/src/*`, rebuild before running the daemon:

```bash
npm run build --workspace=@hubcode/relay
```

The Node daemon imports `@hubcode/relay` from `packages/relay/dist/*`, not `src/*`.

### Server → CLI

When changing `packages/server/src/client/*` (especially `daemon-client.ts`) or shared WS protocol types, rebuild before running CLI commands:

```bash
npm run build --workspace=@hubcode/server
```

The CLI imports `@hubcode/server` via package exports resolving to `dist/*`. Stale `dist` means the CLI speaks an old protocol and fails with handshake warnings or timeouts.

## CLI reference

Use `npm run cli` to run the local CLI (instead of the globally installed `hubcode` which points to the main checkout).

```bash
npm run cli -- ls -a -g              # List all agents globally
npm run cli -- ls -a -g --json       # Same, as JSON
npm run cli -- inspect <id>          # Show detailed agent info
npm run cli -- logs <id>             # View agent timeline
npm run cli -- daemon status         # Check daemon status
```

Use `--host <host:port>` to point the CLI at a different daemon:

```bash
npm run cli -- --host localhost:7777 ls -a
```

## Agent state

Agent data lives at:

```
$HUBCODE_HOME/agents/{cwd-with-dashes}/{agent-id}.json
```

Find an agent by ID:
```bash
find $HUBCODE_HOME/agents -name "{agent-id}.json"
```

Find by content:
```bash
rg -l "some title text" $HUBCODE_HOME/agents/
```

## Provider session files

Get the session ID from the agent JSON (`persistence.sessionId`), then:

**Claude:**
```
~/.claude/projects/{cwd-with-dashes}/{session-id}.jsonl
```

**Codex:**
```
~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-{timestamp}-{session-id}.jsonl
```

## Testing with Playwright MCP

Use Playwright MCP connecting to Metro at `http://localhost:8081` for UI testing.

Do NOT use browser history (back/forward). Always navigate by clicking UI elements or using `browser_navigate` with the full URL — the app uses client-side routing and browser history breaks state.

## Expo troubleshooting

```bash
npx expo-doctor
```

Diagnoses version mismatches and native module issues.

## Typecheck

Always run typecheck after changes:

```bash
npm run typecheck
```
