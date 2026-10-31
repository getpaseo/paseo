# ZCode Provider

A bundled [Paseo](https://github.com/getpaseo/paseo) provider plugin that drives
[ZCode](https://github.com/zai-org/ZCode) over its native `zcode app-server --stdio`
protocol — the same interface the ZCode desktop app uses to spawn its agents.

Paseo opens ZCode sessions, streams replies, renders tool calls, answers permission
requests, switches model/mode, and lists and restores sessions. The ZCode
repository is **not modified**: the provider only talks to the CLI over stdio.

## Requirements

| Component       | Version / notes                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paseo           | `>= 0.14.1-beta.1` (the release that resolves bundled-plugin launch commands)                                                                           |
| A ZCode runtime | One of: the `zcode` CLI on `PATH`, the ZCode desktop app (its bundled runtime is auto-discovered), or `GLM_BINARY_PATH` pointing at a `zcode.cjs` build |
| A ZCode account | Logged in (`zcode login`) **or** Coding Plan API key(s), see [Billing](#billing-personal-and-team-plans)                                                |

There is no npm distribution of the CLI yet. To build one from source:

```bash
git clone https://github.com/zai-org/ZCode.git ~/IdeaProjects/ZCode
cd ~/IdeaProjects/ZCode
pnpm install --filter "@zcode/cli..."
node scripts/build-desktop-agent-cli.mjs && pnpm --filter @zcode/tui build
ln -s "$PWD/apps/zcode-cli/packages/cli/dist/zcode.cjs" ~/.local/bin/zcode  # on PATH
```

## Quick start

The setup script is dependency-free (plain Node ≥ 20) and read-only until you
explicitly register a provider.

```bash
cd plugins/zcode-provider

# 1. Is a ZCode runtime reachable?
node scripts/zcode-setup.js doctor

# 2. What will Paseo sessions see? (spawns app-server, lists every model)
node scripts/zcode-setup.js probe

# 3. (Optional, recommended) log in so your account identity is cached
zcode login bigmodel
```

Then start/restart the Paseo daemon and pick the **zcode** provider in the UI.

## Billing: personal and team plans

ZCode sessions launched by Paseo read manual providers from
`~/.zcode/v2/provider_config.json` (the same file the ZCode desktop app writes).
Register one provider per subscription you want available; both can coexist and
you choose per session.

> **Personal vs team:** the _key_ decides the billing. A key created under your
> personal account bills your personal Coding Plan; a key created under your
> organization bills the Team Coding Plan. Both live in the BigModel console and
> both use the same base URL.

```bash
# Personal Coding Plan
node scripts/zcode-setup.js add-provider \
  --name "BigModel Personal CodingPlan" \
  --api-key <PERSONAL_KEY> \
  --kind personal

# Team Coding Plan (create the key under your organization in the BigModel console)
node scripts/zcode-setup.js add-provider \
  --name "BigModel Team CodingPlan" \
  --api-key <TEAM_KEY> \
  --kind team

# Verify: the probe should now list both providers
node scripts/zcode-setup.js probe
```

Notes:

- `add-provider` is idempotent per `--name` (re-running updates the key/models)
  and writes a timestamped `.bak-*` backup before touching the shared config.
- By default providers speak `openai-chat-completions` against
  `https://open.bigmodel.cn/api/coding/paas/v4`. If your key only works on the
  Anthropic-compatible endpoint, pass
  `--protocol anthropic` (routes to `https://open.bigmodel.cn/api/anthropic`).
- `--config-file PATH` overrides the config location (useful for tests or
  non-default `ZCODE_DATA_BASE_DIR` setups).
- `zcode login bigmodel` additionally caches your account identity so the TUI
  and headless CLI can use account providers directly; the app-server context
  used by Paseo always reads the manual providers above.

## How it works

- **Launch resolution** (first match wins): `agents.providers.zcode.command`
  override → `zcode` on `PATH` → the desktop app's bundled runtime under
  `resources/glm/` → `GLM_BINARY_PATH`. The bundled JavaScript runtime runs as
  `{node} zcode.cjs app-server --stdio` with `ELECTRON_RUN_AS_NODE=1`.
- **Protocol**: newline-delimited JSON frames. Requests are
  `{id, method, params}`, responses `{id, result}` / `{id, error}`. The app
  also sends _reverse requests_ (e.g. `session/requestRuntimePreferences`,
  `interaction/requestPermission`) that the host must answer — the provider
  answers runtime preferences and forwards permission requests to the Paseo UI.
- **Events**: ZCode delivers legacy events by cursor; the transport polls
  `session/events` with `afterSeq` per session.
- **Model catalog**: read from the session snapshot's `settings.model.available`
  (provider label, context window, reasoning levels) and cached per
  executable + workspace.

## Troubleshooting

| Symptom                                                       | Fix                                                                                                               |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ZCode was not found`                                         | Run `node scripts/zcode-setup.js doctor`; check `PATH`, the desktop app, or `GLM_BINARY_PATH`                     |
| Probe lists no models                                         | No manual provider registered and no host sync — run `add-provider` (see Billing)                                 |
| `401` / auth errors on a turn                                 | The API key is invalid or expired; re-run `add-provider` with a fresh key                                         |
| Wrong plan billed                                             | The session's provider decides billing — verify with `probe`, switch model in Paseo                               |
| `Client request timed out: session/requestRuntimePreferences` | Your client did not answer the app-server's reverse request; the bundled transport handles this — keep it enabled |

## Status

The legacy transport is functional and under active development; remaining
tasks (V4 transport, slash-command parity, image prompts) are tracked in
`docs/superpowers/plans/2026-10-30-zcode-provider.md`.
