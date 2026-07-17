# Development

## Prerequisites

- Node.js (see `.tool-versions` for exact version)
- npm workspaces (comes with Node)

## Running the dev server

```bash
npm run dev:server
npm run dev:app
npm run dev:desktop
```

Root checkout dev is intentionally split across terminals:

- `npm run dev:server` runs the daemon on `127.0.0.1:6768`.
- `npm run dev:app` runs Expo on `http://localhost:8081` and connects to the dev daemon.
- `npm run dev:desktop` runs its own Electron-flavored Expo server on the first free port from `8082` through `8089`. It never claims port `8081`.

`npm run dev` is only a shorthand for `npm run dev:server`. Keep `127.0.0.1:6767` for the packaged app and production-style `~/.paseo` state.

### PASEO_HOME

`PASEO_HOME` is the directory that holds runtime state (agents, worktrees, workspace config, sockets, daemon log). Resolution rules:

- The **server itself** (e.g. when launched by the desktop app or `npm run start`) defaults to `~/.paseo` (see `packages/server/src/server/paseo-home.ts`).
- **Repo dev scripts** default to `$ROOT/.dev/paseo-home`, where `$ROOT` is the current checkout or worktree root. This keeps all dev state scoped to the checkout instead of the packaged desktop app.
- **`npm run cli -- ...`** runs through the same dev-home wrapper as the dev scripts, so the in-repo CLI automatically targets the current checkout's `.dev/paseo-home` and configured dev daemon endpoint.
- **Paseo-created worktrees** seed `$PASEO_WORKTREE_PATH/.dev/paseo-home` from `$PASEO_SOURCE_CHECKOUT_PATH/.dev/paseo-home` by copying durable JSON metadata. Runtime files like pid files, sockets, and logs are not copied.
- **This repo's worktree setup** also best-effort seeds `packages/app/ios` and the newest `.dev/ios-build` entry from the source checkout so iOS simulator services can reuse native project and Xcode cache state when it is safe enough to do so.

Override knobs:

```bash
PASEO_HOME=~/.paseo-blue npm run dev          # explicit home
PASEO_DEV_SEED_HOME=/path/to/home npm run dev # seed from a different source home
PASEO_DEV_RESET_HOME=1 npm run dev            # clear and reseed the derived worktree home
```

### Daemon endpoints

- Stable daemon launched by the desktop app: `localhost:6767`.
- Root checkout dev daemon: `localhost:6768`.
- Root checkout Expo: `http://localhost:8081`.
- Root checkout desktop dev Expo: first free port from `8082` through `8089`.
- `npm run dev` (Windows): `localhost:6767` for the daemon.

In Paseo-managed worktree services, use the injected service environment rather than hardcoded root checkout ports.

### Expo Router

Route ownership, startup restore, and native blank-screen gotchas live in
[expo-router.md](expo-router.md). Read it before changing `packages/app/src/app`,
startup routing, remembered workspace restore, or active workspace selection.

### iOS simulator preview service

Paseo worktrees expose the native iOS dev app through the `ios-simulator` service in `paseo.json`. The service URL serves the simulator preview at `/.sim`, so the preview link is `${PASEO_URL}/.sim`.

**Prerequisites (macOS only).** The service shells out to the Apple toolchain, so beyond the `npm ci` that worktree setup runs you must install:

- **Xcode** (the full app, not just the Command Line Tools) — install it from the Mac App Store, or from `developer.apple.com/download` for a specific version. It provides `xcodebuild` and `xcrun simctl`; accept its license and let first-run component installation finish before starting the service.
- **An iOS Simulator runtime with at least one iPhone device type**. Recent Xcode versions may not bundle a runtime — add one via Xcode → Settings → Components (older Xcode: "Platforms"). The service targets `iPhone 16 Pro` by default (override with `PASEO_IOS_DEVICE_TYPE`) and falls back to any iPhone; it fails with `No iPhone simulator device type is installed` when none exist.
- **Homebrew** — CocoaPods itself installs automatically: `expo prebuild` runs `pod install` on a cold worktree, and when the CocoaPods CLI is missing the runner installs it for you. It tries `gem install cocoapods` first and falls back to Homebrew (`brew install cocoapods`), so having Homebrew available lets that fallback succeed without a manual step.

`serve-sim`, Expo, and Metro come from `npm ci`, and CocoaPods installs itself on the first prebuild as described above.

The service is designed for concurrent worktrees: it derives a deterministic simulator identity from the worktree path, uses the worktree's assigned `PASEO_PORT`, pins `serve-sim` to that simulator UDID, and only tears down that worktree's helper/simulator state. It must not rely on the globally booted simulator or any fixed Metro port.

Worktree setup best-effort seeds the generated iOS project and newest native build cache from the source checkout before the service runs. The service still validates the native project by running Expo prebuild and Xcode; the seed only avoids paying all setup/build cost from a cold worktree every time.

Starting the service must not create, focus, reveal, or leave behind macOS Simulator.app windows — a guard hides Simulator.app every 250ms, so the native window vanishes if you focus it. The user-visible surface is the interactive `/.sim` preview: a `serve-sim` stream (60 FPS MJPEG + a WebSocket control channel) that Metro mounts at `basePath: "/.sim"` (`packages/app/metro.config.cjs`) and that forwards taps and gestures, so first-launch prompts like "Open in PaseoDebug?" are answered there, not in the native window. Open the `${PASEO_URL}/.sim` link the service prints — not `serve-sim`'s raw stream port (`:3100`), which is view-only. Because the stream sits behind the daemon proxy it is convenient for remote viewing but laggy up close; for fast local dev at the Mac, use the native simulator path below.

**Troubleshooting.** If `xcrun simctl` fails with `unable to find utility "simctl"`, the active developer directory is still the Command Line Tools even though Xcode is installed. Point it at Xcode: `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`, then confirm with `xcrun --find simctl`.

### Running the iOS app on a local simulator

For fast, native, interactive iOS dev at the Mac — as opposed to the remote `/.sim` preview above — skip the service and build the dev client directly:

```bash
npm run ios        # → expo run:ios (packages/app): builds and launches the app in the real Simulator.app
```

`expo run:ios` starts its own Metro and gives you the normal Simulator.app window (full speed, native touch, no stream).

**Pointing the app at a daemon.** The client resolves its local daemon from `EXPO_PUBLIC_LOCAL_DAEMON` (`packages/app/src/runtime/host-runtime.ts`); when unset it falls back to `localhost:6767`, the production `~/.paseo` daemon. To target a worktree's dev daemon instead, set it on the build command:

```bash
EXPO_PUBLIC_LOCAL_DAEMON=localhost:${PASEO_SERVICE_DAEMON_PORT} npm run ios   # worktree daemon running as a Paseo service
EXPO_PUBLIC_LOCAL_DAEMON=localhost:6768 npm run ios                          # standalone `npm run dev:server`
```

The iOS simulator shares the Mac's loopback, so `localhost:<port>` reaches the host daemon directly.

**Gotcha — `EXPO_PUBLIC_*` is inlined into the JS bundle at Metro bundle time, not read at runtime.** Set it in the same shell that starts Metro. If the app still connects to the old daemon, Metro served a cached bundle; re-bundle clean with `cd packages/app && EXPO_PUBLIC_LOCAL_DAEMON=… npx expo start -c` and reload the app.

### Desktop renderer profiling

`npm run dev:desktop` starts Electron with Chromium remote debugging enabled on
`http://127.0.0.1:9223` so renderer CPU profiles can be captured through CDP.
It launches its own Electron-flavored Expo server and passes that URL to Electron.
Override the CDP port with `PASEO_ELECTRON_REMOTE_DEBUGGING_PORT` when `9223` is busy.

With desktop dev running, verify the real BrowserWindow, titlebar clearance, fullscreen
transition, and 751-pixel settings split with:

```bash
npm run verify:electron-cdp --workspace=@getpaseo/desktop
```

The verifier reads the same `EXPO_PORT` and
`PASEO_ELECTRON_REMOTE_DEBUGGING_PORT` environment names as desktop dev. Set both when
testing an isolated instance on non-default ports.

When running a dedicated Electron QA instance against a non-default Expo port, set
`EXPO_DEV_URL` explicitly. Desktop main defaults to `http://localhost:8081`, so
`PASEO_PORT=57928` alone starts Metro on 57928 but Electron still loads 8081.

### React render profiling

The app has a gated React render profiler in
`packages/app/src/utils/render-profiler.tsx`. Wrap the component boundary you want
to measure with `RenderProfile`, then open the app with `?renderProfile=1`. When
the query param is absent, `RenderProfile` returns children directly and records
nothing.

Captured samples are exposed on `globalThis.__PASEO_RENDER_PROFILE__`. Call
`globalThis.__PASEO_RESET_RENDER_PROFILE__?.()` after warm-up and before the
interaction you want to measure. If a memo comparator or subscription boundary
needs explanation, call `recordRenderProfileReasons(id, reasons)` while profiling;
reason counts are exposed on `globalThis.__PASEO_RENDER_PROFILE_REASONS__`.

Use this workflow for any render investigation:

1. Add stable `RenderProfile` boundaries around the suspected root and expensive
   children. Keep IDs specific enough to compare before and after.
2. Reproduce against real app state, not toy fixtures, whenever practical.
3. Record an idle baseline first. If idle is noisy, fix or account for that
   before optimizing the interaction.
4. Warm up the route, reset profiler samples, run the exact interaction, then
   compare `actualDuration`, render counts, and per-commit samples.
5. When a memo boundary still renders, record reasons before changing code. Do
   not guess from object identity alone.
6. Keep changes that move the measured profile. Remove probes or memo wrappers
   that do not move the number.

What this caught during the workspace tab investigation:

- A large apparent workspace cost was real interaction work, not daemon noise;
  the idle baseline stayed near zero.
- The expensive stream rerender was mostly prop identity churn from pane context
  callbacks and capability objects, not new stream data.
- Stabilizing provider actions at the pane boundary helped because every mounted
  panel consumes that context.
- Comparing value-shaped capability flags beat preserving object identity through
  unrelated stores.
- Some plausible fixes did not pay off: memoizing the tab row and composer draft
  object barely moved the profile, so they were removed.

Existing scenario script: workspace agent/terminal tab switching. Start Expo on
web, keep a daemon available, then run:

```bash
PASEO_PROFILE_SERVER_ID=<server-id> \
PASEO_PROFILE_WORKSPACE_ID=<workspace-path> \
PASEO_PROFILE_AGENT_ID=<agent-id> \
  npm run profile:workspace-tabs --workspace=@getpaseo/app
```

This script opens the app with `?renderProfile=1`, creates a temporary terminal
tab, switches between a real agent and that terminal, prints aggregated React
Profiler timings, then removes the temporary terminal. It is an example of the
workflow above, not the only way to use the profiler. Useful knobs:

```bash
PASEO_PROFILE_APP_URL=http://localhost:19010 # Expo web URL
PASEO_PROFILE_SWITCH_COUNT=1                # number of agent/terminal switch pairs
PASEO_PROFILE_SWITCH_WAIT_MS=250            # delay after each click
PASEO_PROFILE_IDLE_WAIT_MS=3000             # idle baseline before switching
PASEO_PROFILE_DUMP_COMMITS=1                # include per-commit profiler samples
```

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

The watchdog deliberately leaves background throttling **enabled**. Calling
`webContents.setBackgroundThrottling(false)` would keep the compositor producing
frames non-stop, pinning ProMotion displays at 120Hz forever and draining the
battery while the app is idle — so do not re-add it. The probe's visibility
guards already prevent throttling from causing a false stall.

### Daemon logs

Check `$PASEO_HOME/daemon.log` for daemon logs. The default level is `info`; set
`PASEO_LOG_LEVEL=trace` before launching the daemon when you need full provider,
session, and agent-manager traces for stuck-state debugging.

The supervisor rotates `daemon.log`. Persisted `log.file.rotate` settings in
`$PASEO_HOME/config.json` win first. Without persisted config, the optional
`PASEO_LOG_ROTATE_SIZE` and `PASEO_LOG_ROTATE_COUNT` env vars override the
defaults. The default rotation is `10m` x `3` files everywhere.

### Agent Tool Catalog Measurement

Measure the MCP `tools/list` payload that Paseo injects into agents with:

```bash
npm run measure:agent-tools --workspace=@getpaseo/server
```

The command reports compact JSON bytes, estimated tokens, field totals, largest
tools, and the browser-tools delta. It defaults to the agent-scoped catalog; use
`-- --scope=top-level` for the unaffiliated `/mcp/agents` shape and `-- --json`
for machine-readable output.

## paseo.json service scripts

`worktree.setup` and `worktree.teardown` accept either a multiline shell script or an array
of commands. Both run sequentially.

Lifecycle commands run in the worktree through a stable script shell: `bash`
resolved from `PATH` on macOS/Linux, and PowerShell with `-NoProfile` on
Windows. They inherit the daemon environment plus Paseo's lifecycle variables;
login and interactive shell startup files are not loaded, and Bash's `BASH_ENV`
hook is unset. Daemon-run loop verify checks and ACP single-string terminal
commands use the same non-login Bash behavior on macOS/Linux, but preserve their
existing `cmd.exe /c` string semantics on Windows. Service scripts are separate:
they launch in a terminal and receive the service environment described below.

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
| `PASEO_SERVICE_<NAME>_URL`  | Proxied URL for a declared peer service. Prefer this for peer discovery; it survives peer restarts.                       |
| `PASEO_SERVICE_<NAME>_PORT` | Raw ephemeral port for a declared peer service. Use only as a bypass escape hatch; it can go stale if that peer restarts. |
| `PASEO_URL`                 | Self alias for `PASEO_SERVICE_<SELF>_URL`.                                                                                |
| `PASEO_PORT`                | Self alias for `PASEO_SERVICE_<SELF>_PORT`.                                                                               |
| `HOST`                      | Bind host for the service process.                                                                                        |

Service proxy hostnames use the double-dash shape: `web--feature-auth--project.localhost` or, on the default branch, `web--project.localhost`. Optional public aliases use the same leftmost label under the configured public base host.

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

## Bundled daemon web UI

> The user-facing guide for this feature (enabling it, reverse proxy, TLS, tunnels, security) lives at [public-docs/web-ui.md](../public-docs/web-ui.md). This section is the contributor/build reference: how the artifact is produced, bundled, and excluded from desktop packaging.

The daemon can optionally serve the browser web client from the same HTTP server. This is disabled by default.

Enable it for a running daemon with:

```bash
paseo daemon start --web-ui
```

Or set the environment variable:

```bash
PASEO_WEB_UI_ENABLED=true paseo daemon start
```

Or persist it in `config.json`:

```json
{
  "features": {
    "webUi": {
      "enabled": true
    }
  }
}
```

When enabled, opening the daemon HTTP origin (for example `http://localhost:6767/`) serves the web app. The same HTTP server continues to serve `/api/*`, `/mcp/*`, `/public/*`, the WebSocket upgrade, and service-proxy routes. Static files load without daemon bearer auth; API and WebSocket calls still enforce auth.

The served app auto-bootstraps a connection to the same origin, so opening `http://localhost:6767/` directly usually skips the Add Host step.

Build the artifact for packaging or measurement with:

```bash
npm run build:daemon-web-ui
```

This exports the normal browser web app (not the Electron-flavored desktop renderer) and copies it into `packages/server/dist/server/web-ui`, precompressing `.html`, `.js`, `.css`, and JSON assets as `.br` and `.gz`.

Measured bundle size for a standard Expo web export:

- raw: 10.77 MiB
- gzip: 2.55 MiB
- brotli: 1.93 MiB

The desktop-managed daemon disables the bundled web UI by default (`PASEO_WEB_UI_ENABLED=false`) because the desktop app already ships the renderer as `app-dist`. Shipping the same assets again inside `@getpaseo/server` would duplicate the ~10.8 MiB install. Desktop packaging also excludes `node_modules/@getpaseo/server/dist/server/web-ui/**` from the packaged app.

## Built workspace packages

Package imports resolve through package exports to compiled `dist/` output, not sibling `src/` files. This is true in local dev and in published packages: the app, daemon, CLI, and SDK consumers should all exercise the same runtime paths.

`npm run dev:server` builds the server-side workspace packages once, then keeps `@getpaseo/protocol` and `@getpaseo/client` fresh with TypeScript watch builds while the daemon runs. If you change protocol schemas or client code outside that watch workflow, rebuild the producer before trusting runtime behavior.

Use the named root build targets instead of remembering workspace dependency chains:

```bash
npm run build:client       # protocol -> client
npm run build:server-deps  # highlight -> relay -> protocol -> client
npm run build:server       # server-deps -> server -> cli
npm run build:app-deps     # highlight -> protocol -> client -> expo-two-way-audio
```

Use `npm run build:server` whenever you have changed any daemon/server-facing package and need clean cross-package types or runtime behavior.

The app Metro config disables Watchman and uses Metro's node crawler for exports. Keep that invariant unless you have verified production app exports on machines with and without Watchman installed; distro Watchman builds can differ in capabilities and change Metro's crawl behavior.

For tighter loops, you can rebuild a single workspace:

- Changed `packages/protocol/src/*` or `packages/client/src/*`: `npm run build:client`.
- Changed `packages/server/src/*`, `packages/cli/src/*`, `packages/relay/src/*`, or `packages/highlight/src/*`: `npm run build:server`.
- Changed app build dependencies: `npm run build:app-deps`.

## ACP provider catalog versions

The in-app ACP provider catalog pins package-runner entries (`npx`, `npm exec`,
and `uvx`) to exact package versions. Run the drift checker regularly — and
before releases — so catalog installs do not sit on stale agent versions:

```bash
npm run acp:version-drift        # report stale/non-exact package pins
npm run acp:version-drift:check  # same, exits non-zero on drift
npm run acp:version-drift:update # rewrite catalog pins to latest exact versions
```

The checker updates only package-runner catalog entries. Providers that use a
preinstalled binary such as `opencode acp`, `cursor-agent acp`, or `goose acp`
are reported as skipped because their versions are owned by the user's local
install.

## CLI reference

Use `npm run cli` to run the in-repo CLI from source (`npx tsx packages/cli/src/index.ts`). The script wraps the CLI with `scripts/dev-home.sh`, so it automatically uses this checkout's `.dev/paseo-home` and dev daemon endpoint unless you pass an explicit override. The globally installed `paseo` binary on macOS is a symlink into the installed Paseo desktop app, not this checkout — use it to drive the desktop's built-in daemon, but use `npm run cli` when you want to talk to the CLI you are editing.

```bash
npm run cli -- ls -a -g              # List all agents globally
npm run cli -- ls -a -g --json       # Same, as JSON
npm run cli -- inspect <id>          # Show detailed agent info
npm run cli -- logs <id>             # View agent timeline
npm run cli -- daemon status         # Check daemon status
npm run cli -- clone owner/repo --dir ~/workspace # Clone GitHub repo and register project
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

Point Playwright MCP at the running Expo web target. For root checkout dev, `npm run dev:app` reserves `http://localhost:8081`. For Paseo-managed worktree app services, use the service URL or port shown by Paseo for that worktree.

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
