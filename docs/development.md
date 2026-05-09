# Development

## Prerequisites

- Node.js (see `.tool-versions` for exact version)
- npm workspaces (comes with Node)

## Running the dev server

```bash
npm run dev
```

`scripts/dev.sh` runs the daemon and Expo together via `concurrently`, fronted by [`portless`](https://www.npmjs.com/package/portless) so each service is reachable at a stable name like `https://daemon.localhost` / `https://app.localhost` instead of a fixed port. The underlying TCP ports are ephemeral — never hardcode them. (Windows uses `scripts/dev.ps1`, which still binds the daemon to `localhost:6767` directly.)

### PASEO_HOME

`PASEO_HOME` is the directory that holds runtime state (agents, sockets, daemon log). Resolution rules:

- The **server itself** (e.g. when launched by the desktop app or `npm run start`) defaults to `~/.paseo` (see `packages/server/src/server/paseo-home.ts`).
- **`npm run dev` from a git worktree** derives a stable home like `~/.paseo-<worktree-name>` and, on first run, seeds it from `~/.paseo` by copying agent/project JSON metadata and `config.json`. Checkout/worktree directories are not copied.
- **`npm run dev` from the main checkout** (not a worktree) uses a fresh `mktemp` directory under `$TMPDIR` and removes it on exit. Set `PASEO_HOME` explicitly to keep state across runs.

Override knobs:

```bash
PASEO_HOME=~/.paseo-blue npm run dev          # explicit home
PASEO_DEV_SEED_HOME=/path/to/home npm run dev # seed from a different source home
PASEO_DEV_RESET_HOME=1 npm run dev            # clear and reseed the derived worktree home
```

### Daemon endpoints

- Stable daemon launched by the desktop app: `localhost:6767`.
- `npm run dev` (macOS/Linux): portless URLs only — read them from the `dev.sh` banner or `portless get daemon` / `portless get app`.
- `npm run dev` (Windows): `localhost:6767` for the daemon.

In any worktree-style or portless setup, never assume default ports.

### Daemon logs

Check `$PASEO_HOME/daemon.log` for trace-level logs.

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

The daemon and CLI consume sibling workspaces from compiled `dist/` output, not `src/`. When you change a workspace that something else imports, rebuild the producer first or the consumer will speak a stale protocol and fail with handshake warnings, timeouts, or stale type errors.

The fastest way to keep this consistent is to rebuild the whole daemon stack with one command:

```bash
npm run build:daemon
```

This rebuilds, in order, `@getpaseo/highlight` → `@getpaseo/relay` → `@getpaseo/server` → `@getpaseo/cli`. Use it whenever you have changed any of those four and need clean cross-package types or runtime behavior.

For tighter loops, you can rebuild a single workspace:

- Changed `packages/relay/src/*`: `npm run build --workspace=@getpaseo/relay` (server imports `@getpaseo/relay` from `dist/*`).
- Changed `packages/server/src/client/*` (especially `daemon-client.ts`) or shared WS protocol types: `npm run build --workspace=@getpaseo/server` (CLI imports `@getpaseo/server` via package exports resolving to `dist/*`).
- Changed `packages/highlight/src/*`: `npm run build --workspace=@getpaseo/highlight` (server depends on it).

## CLI reference

Use `npm run cli` to run the in-repo CLI from source (`npx tsx packages/cli/src/index.ts`). The globally installed `paseo` binary on macOS is a symlink into the installed Paseo desktop app, not this checkout — use it to drive the desktop's built-in daemon, but use `npm run cli` when you want to talk to the CLI you are editing.

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

Point Playwright MCP at the running Expo web target. Under `npm run dev` (macOS/Linux) that is the portless URL printed in the dev banner — typically `https://app.localhost`. If you start Expo directly with `expo start --web` (no portless), Metro defaults to `http://localhost:8081`.

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
