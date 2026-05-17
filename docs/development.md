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

### Desktop renderer profiling

`npm run dev:desktop` starts Electron with Chromium remote debugging enabled on
`http://127.0.0.1:9223` so renderer CPU profiles can be captured through CDP.
Override the port with `PASEO_ELECTRON_REMOTE_DEBUGGING_PORT` when `9223` is busy.

### Desktop macOS compositor watchdog

macOS display sleep can leave Chromium's GPU-process display link — the vsync
source that drives frame production — stuck on a stale display. The compositor
then stops producing frames and the window looks frozen: unresponsive to clicks
and keys even though the renderer and every process stay alive. It self-recovers
after a few minutes, which is too long for a foreground app.

`setupDarwinCompositorWatchdog`
(`packages/desktop/src/window/compositor-watchdog/index.ts`) guards against
this. It polls the renderer for frame production every couple of seconds and,
after a sustained stall while the window is visible and unlocked, restarts the
GPU process so Chromium rebuilds the display link. The probe is skipped while
the screen is locked or the window is hidden or minimized, since a window
legitimately stops producing frames then.

### Daemon logs

Check `$PASEO_HOME/daemon.log` for daemon logs. The default level is `info`; set
`PASEO_LOG_LEVEL=trace` before launching the daemon when you need full provider,
session, and agent-manager traces for stuck-state debugging.

The supervisor rotates `daemon.log`. Persisted `log.file.rotate` settings in
`$PASEO_HOME/config.json` win first. Without persisted config, the optional
`PASEO_LOG_ROTATE_SIZE` and `PASEO_LOG_ROTATE_COUNT` env vars override the
defaults. The default rotation is `10m` x `3` files everywhere.

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

## Built workspace packages

Package imports resolve through package exports to compiled `dist/` output, not sibling `src/` files. This is true in local dev and in published packages: the app, daemon, CLI, and SDK consumers should all exercise the same runtime paths.

`npm run dev`, `npm run dev:server`, and `npm run dev:app` build the workspace packages they need once, then keep `@getpaseo/protocol` and `@getpaseo/client` fresh with TypeScript watch builds while the daemon or Expo runs. If you change protocol schemas or client code outside those watch workflows, rebuild the producer before trusting runtime behavior.

Use the named root build targets instead of remembering workspace dependency chains:

```bash
npm run build:client       # protocol -> client
npm run build:server-deps  # highlight -> relay -> protocol -> client
npm run build:server       # server-deps -> server -> cli
npm run build:app-deps     # highlight -> protocol -> client -> expo-two-way-audio
```

Use `npm run build:server` whenever you have changed any daemon/server-facing package and need clean cross-package types or runtime behavior.

For tighter loops, you can rebuild a single workspace:

- Changed `packages/protocol/src/*` or `packages/client/src/*`: `npm run build:client`.
- Changed `packages/server/src/*`, `packages/cli/src/*`, `packages/relay/src/*`, or `packages/highlight/src/*`: `npm run build:server`.
- Changed app build dependencies: `npm run build:app-deps`.

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

## App web deploys

`packages/app` exports a single-page Expo web app and deploys the `dist/`
directory to Cloudflare Pages with `npm run deploy:web --workspace=@getpaseo/app`.

PWA install metadata lives in `packages/app/public/manifest.json` and is linked
from `packages/app/public/index.html`. Keep the install icons in `public/` so
Cloudflare serves them from stable root URLs after `expo export`.

Do not add service-worker caching casually. Paseo is a live control surface for
agents, and an aggressive service worker can strand installed users on stale web
code. If offline behavior becomes a product requirement, add it deliberately
with an update strategy and test the installed-app upgrade path.

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
