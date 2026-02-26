# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Junction is a mobile app for monitoring and controlling your local AI coding agents from anywhere. Your dev environment, in your pocket.

**Key features:**
- Real-time streaming of agent output
- Voice commands for hands-free interaction
- Push notifications when tasks complete
- Multi-agent orchestration across projects

**Not a cloud sandbox** - Junction connects directly to your actual development environment. Your code stays on your machine.

**Supported agents:** Claude Code, Codex, and OpenCode.

## Monorepo Structure

This is a pnpm workspace monorepo:

- **packages/server**: The Junction daemon that runs on your machine. Manages agent processes, provides WebSocket API for real-time streaming, and exposes an MCP server for agent control.
- **packages/app**: Cross-platform client (Expo). Connects to one or more servers, displays agent output, handles voice input, and sends push notifications.
- **packages/cli**: The `junction` CLI that is used to manage the deamon, and acts as a client to it with  Docker-style commands like `junction run/ls/logs/wait`
- **packages/website**: Marketing site at junction.sh (TanStack Router + Cloudflare Workers).

## Development Server

The `pnpm run dev` script automatically picks an available port for the development server.

When running in a worktree or alongside the main checkout, set `JUNCTION_HOME` to isolate state:

```bash
JUNCTION_HOME=~/.junction-blue pnpm run dev
```

- `JUNCTION_HOME` – path for runtime state (agent data, sockets, etc.). Defaults to `~/.junction`; set this to a unique directory when running a secondary server instance.

## Running and checking logs

Both the server and Expo app are running in a Tmux session. See CLAUDE.local.md for system-specific session details.

## Debugging

### Daemon and CLI

The Junction daemon communicates via WebSocket. In the main checkout:
- Daemon runs at `localhost:6767`
- Expo app at `localhost:8081`
- State lives in `$JUNCTION_HOME`

In worktrees or when running `pnpm run dev`, ports and home directories may differ. Never assume the defaults.

Use `pnpm run cli` to run the local CLI (instead of the globally linked `junction` which points to the main checkout). Always run `pnpm run cli -- --help` or load the `/junction` skill before using it - do not guess commands.

Use `--host <host:port>` to point the CLI at a different daemon (e.g., `--host localhost:7777`).

### Relay build sync (important)

When changing `packages/relay/src/*`, rebuild relay before running/debugging the daemon:

```bash
pnpm --filter @junction/relay run build
```

Reason: Node daemon imports `@junction/relay` from `packages/relay/dist/*` (`node` export path), not directly from `src/*`.

### Server build sync for CLI (important)

When changing `packages/server/src/client/*` (especially `daemon-client.ts`) or shared WS protocol types, rebuild server before running/debugging CLI commands:

```bash
pnpm --filter @junction/server run build
```

Reason: local CLI imports `@junction/server` via package exports that resolve to `packages/server/dist/*` first. If `dist` is stale, CLI can speak an old protocol (for example, sending `session` before `hello`) and fail with handshake warnings/timeouts.

### Quick reference CLI commands

```bash
pnpm run cli -- ls -a -g              # List all agents globally
pnpm run cli -- ls -a -g --json       # Same, as JSON
pnpm run cli -- inspect <id>          # Show detailed agent info
pnpm run cli -- logs <id>             # View agent timeline
pnpm run cli -- daemon status         # Check daemon status
```

### Agent state

Agent data is stored at:
```
$JUNCTION_HOME/agents/{cwd-with-dashes}/{agent-id}.json
```

To find an agent by ID:
```bash
find $JUNCTION_HOME/agents -name "{agent-id}.json"
```

To find an agent by title or other content:
```bash
rg -l "some title text" $JUNCTION_HOME/agents/
rg -l "spiteful-toad" $JUNCTION_HOME/agents/
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

### Android variants (vanilla Expo)

Use `APP_VARIANT` in `packages/app/app.config.js` to control app name + package ID (no custom Gradle flavor plugin):

- `production` -> app name `Junction`, package `sh.junction`
- `development` -> app name `Junction Debug`, package `sh.junction.debug`

EAS profiles live in `packages/app/eas.json` as `development`, `production`, and `production-apk`.

`development` uses Android `debug`.

### Local build + install (Android device)

From `packages/app`:

```bash
# development (debug)
APP_VARIANT=development pnpm exec expo prebuild --platform android --clean --non-interactive
APP_VARIANT=development pnpm exec expo run:android --variant=debug

# production (release)
APP_VARIANT=production pnpm exec expo prebuild --platform android --clean --non-interactive
APP_VARIANT=production pnpm exec expo run:android --variant=release
```

From repo root:

```bash
pnpm run android:development
pnpm run android:production
```

`pnpm run android:prod` and `pnpm run android:release` are aliases for `pnpm run android:production`.

### Cloud build + submit (EAS Workflows)

Tag pushes like `v0.1.0` trigger `packages/app/.eas/workflows/release-mobile.yml` on Expo servers.
Tag pushes like `v0.1.0` also trigger `.github/workflows/android-apk-release.yml` on GitHub Actions to publish an APK asset on the matching GitHub Release.

That workflow does:
- Build iOS with the `production` profile
- Build Android with the `production` profile
- Submit each build with the `production` submit profile

Useful commands:

```bash
# List recent mobile workflow runs
cd packages/app && pnpm exec eas workflow:runs --workflow release-mobile.yml --limit 10

# Inspect one run (jobs, status, outputs)
cd packages/app && pnpm exec eas workflow:view <run-id>

# Stream logs for all steps in one failed job
cd packages/app && pnpm exec eas workflow:logs <job-id> --non-interactive --all-steps
```

## Testing with Playwright MCP

**CRITICAL:** When asked to test the app, you MUST use the Playwright MCP connecting to Metro at `http://localhost:8081`.

Use the Playwright MCP to test the app in Metro web. Navigate to `http://localhost:8081` to interact with the app UI.

**Important:** Do NOT use browser history (back/forward). Always navigate by clicking UI elements or using `browser_navigate` with the full URL. The app uses client-side routing and browser history navigation breaks the state.

## Expo troubleshooting

Run `pnpm exec expo-doctor` to diagnose version mismatches and native module issues.

## Release playbook

Use the scripted release flow from repo root. Avoid manual version bumps, manual tags, or ad hoc publish commands unless debugging.

```bash
# Recommended: full patch release (bump, check, publish, push branch+tag)
pnpm run release:patch

# Manual, step-by-step fallback:
pnpm run version:all:patch  # bumps root version, syncs workspaces (creates commit + local tag)
pnpm run release:check
pnpm run release:publish
pnpm run release:push       # pushes HEAD and current version tag (triggers desktop + Android APK + EAS mobile workflows)
```

Notes:
- `version:all:*` bumps the root package version and runs the root `version` lifecycle script to sync workspace versions and internal `@junction/*` dependency versions before the release commit/tag is created.
- `release:prepare` refreshes workspace `node_modules` links to prevent stale local package types during release checks.
- If `release:publish` fails after a successful publish of one workspace, re-run `pnpm run release:publish`; pnpm will skip already-published versions and continue where possible.
- If a user asks to "release junction" (without specifying major/minor), treat it as a patch release and run `pnpm run release:patch`.
- All workspaces share one version by design. Keep versions synchronized and release together.
- The website Mac download CTA URL is derived from `packages/website/package.json` version at build time, so no manual update is required after release.

Release completion checklist:
- Manually update CHANGELOG.md with release notes, between current release vs previous one, use Git commands to figure out what changed. The notes are user-facing:
    - Ask yourself, what do Junction users want to know about?
    - Include: New features, bug fixes
    - Don't include: Refactors or code changes that are not noticeable by users
- `pnpm run release:patch` completes successfully.
- GitHub `Desktop Release` workflow for the new `v*` tag is green.
- GitHub `Android APK Release` workflow for the same tag is green.
- EAS `release-mobile.yml` workflow for the same tag is green (Expo queues can take longer on the free plan).

## Orchestrator Mode

- **When agent control tool calls fail**, make sure you list agents before trying to launch another one. It could just be a wait timeout.
- **Always prefix agent titles** so we can tell which ones are running under you (e.g., "🎭 Feature Implementation", "🎭 Design Discussion").
- **Launch agents in the most permissive mode**: Use full access or bypass permissions mode.
- **Set cwd to the repository root** - The agent's working directory should usually be the repo root

**CRITICAL: ALWAYS RUN TYPECHECK AFTER EVERY CHANGE.**

## Agent Authentication

All agent providers (Claude, Codex, OpenCode) handle their own authentication outside of environment variables. They are authenticated without providing any extra configuration—Junction does not manage API keys or tokens for agents.

**Do not add auth checks to tests.** If auth fails for whatever reason, let the user know instead of patching the code or adding conditional skips.

## NEVER DO THESE THINGS

- **NEVER restart the main Junction daemon on port 6767 without permission** - This is the production daemon that launches and manages agents. If you are reading this, you are probably running as an agent under it. Restarting it will kill your own process and all other running agents. The daemon is managed by the user in Tmux.
- **NEVER assume a timeout means the service needs restarting** - Timeouts can be transient network issues, not service failures
- **NEVER add authentication checks to tests** - Agent providers handle their own auth. If tests fail due to auth issues, report it rather than adding conditional skips or env var checks
