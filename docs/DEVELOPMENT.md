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

Set `PASEO_HOME` to isolate state when running a second instance (e.g., in a worktree):

```bash
PASEO_HOME=~/.paseo-blue npm run dev
```

- `PASEO_HOME` — path for runtime state (agents, sockets, etc.). Defaults to `~/.paseo`.
- In git worktrees, `npm run dev` derives a stable home like `~/.paseo-<worktree-name>`.
  On first run, it seeds that home from `~/.paseo` by copying agent/project JSON metadata
  and `config.json`; actual checkout/worktree directories are not copied.
- `PASEO_DEV_SEED_HOME=/path/to/home npm run dev` seeds from a different source home.
- `PASEO_DEV_RESET_HOME=1 npm run dev` clears and reseeds the derived worktree home.

### Default ports

In the main checkout:

- Daemon: `localhost:6767`
- Expo app: `localhost:8081`

In worktrees or with `npm run dev`, ports may differ. Never assume defaults.

### Daemon logs

Check `$PASEO_HOME/daemon.log` for trace-level logs.

### Database queries

Run arbitrary SQL against the SQLite database:

```bash
# Show table row counts
npm run db:query

# Run any SQL
npm run db:query -- "SELECT agent_id, title, last_status FROM agent_snapshots"
npm run db:query -- "SELECT agent_id, seq, item_kind FROM agent_timeline_rows ORDER BY committed_at DESC LIMIT 10"

# Point at a specific DB directory
npm run db:query -- --db /path/to/db "SELECT ..."
```

Auto-detects the running dev daemon's database from `/tmp/paseo-dev.*`, `PASEO_HOME`, or `~/.paseo/db`.
Pass either a DB directory or a `paseo.sqlite` file to `--db`. The script opens the database directly in read-only mode.

## paseo.json service scripts

`worktree.setup` and `worktree.teardown` accept either a multiline shell script or an array
of commands. Both run sequentially.

```json
{
  "worktree": {
    "setup": "npm ci\ncp \"$PASEO_SOURCE_CHECKOUT_PATH/.env\" .env\nnpm run db:migrate",
    "teardown": "npm run db:drop || true"
  }
}
```

Every `scripts` entry with `"type": "service"` receives these environment variables:

| Variable                    | Value                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `PASEO_SERVICE_<NAME>_URL`  | Proxied daemon URL for a declared peer service. Prefer this for peer discovery; it survives peer restarts.                |
| `PASEO_SERVICE_<NAME>_PORT` | Raw ephemeral port for a declared peer service. Use only as a bypass escape hatch; it can go stale if that peer restarts. |
| `PASEO_URL`                 | Self alias for `PASEO_SERVICE_<SELF>_URL`.                                                                                |
| `PASEO_PORT`                | Self alias for `PASEO_SERVICE_<SELF>_PORT`.                                                                               |
| `HOST`                      | Bind host for the service process.                                                                                        |

`<NAME>` is normalized from the script name by uppercasing it, replacing each run of non-`A-Z0-9` characters with `_`, and trimming leading or trailing `_`. For example, `app-server` and `app.server` both normalize to `APP_SERVER`; that collision fails at spawn time with an actionable error.

`PORT` is not injected by default. If a framework requires `PORT`, set it in the command:

```json
{
  "scripts": {
    "web": {
      "type": "service",
      "command": "PORT=$PASEO_PORT npm run dev:web"
    }
  }
}
```

## Build sync gotchas

### Relay → Daemon

When changing `packages/relay/src/*`, rebuild before running the daemon:

```bash
npm run build --workspace=@getpaseo/relay
```

The Node daemon imports `@getpaseo/relay` from `packages/relay/dist/*`, not `src/*`.

### Server → CLI

When changing `packages/server/src/client/*` (especially `daemon-client.ts`) or shared WS protocol types, rebuild before running CLI commands:

```bash
npm run build --workspace=@getpaseo/server
```

The CLI imports `@getpaseo/server` via package exports resolving to `dist/*`. Stale `dist` means the CLI speaks an old protocol and fails with handshake warnings or timeouts.

## CLI reference

Use `npm run cli` to run the local CLI (instead of the globally installed `paseo` which points to the main checkout).

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
$PASEO_HOME/agents/{cwd-with-dashes}/{agent-id}.json
```

Find an agent by ID:

```bash
find $PASEO_HOME/agents -name "{agent-id}.json"
```

Find by content:

```bash
rg -l "some title text" $PASEO_HOME/agents/
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
