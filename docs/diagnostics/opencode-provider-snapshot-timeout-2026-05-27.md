# OpenCode Provider Snapshot Startup Timeout Diagnosis - 2026-05-27

## Answer

The startup timeout is real OpenCode provider snapshot work, not an agent resume path.

In the dev-style copied-home reproduction, the OpenCode snapshot misses the 30s budget because several expensive things stack:

1. Paseo starts from a copied `PASEO_HOME` containing 4,851 agent records.
2. Clients ask for provider snapshots for three cwd scopes at almost the same time:
   - `/Users/moboudra`
   - `/Users/moboudra/dev/paseo`
   - `/Users/moboudra/dev/blankpage/editor`
3. Each OpenCode snapshot runs two OpenCode SDK calls:
   - `GET /provider?directory=...` through `client.provider.list()`
   - `GET /agent?directory=...` through `client.app.agents()`
4. One cold `opencode serve` process is shared by the three cwd scopes. It took 8.562s to become ready.
5. After OpenCode was listening, Paseo issued six OpenCode HTTP calls concurrently.
6. The OpenCode `/provider` responses are large: about 3,549,620 decompressed bytes per cwd.
7. During the same window, the daemon was still doing heavy startup workspace git work. In the exact 18:14:19-18:14:43 window, the daemon log has 292 git spawn/close events.
8. The `/provider` calls eventually succeeded, but too late: they completed about 32.2s-32.5s after the snapshot fetch started, while the snapshot timeout is 30s.

So the root cause is:

```text
Cold OpenCode server startup + three concurrent cwd snapshots + large OpenCode /provider responses + daemon startup git contention causes client.provider.list() to complete after Paseo's 30s snapshot budget.
```

More precise wording: the contention is machine-level process/CPU/filesystem contention created by daemon startup work, especially git work. It is not proven to be an OpenCode internal lock or a Paseo-only event-loop issue. A daemon-free repro with only OpenCode plus an external git storm slowed the same six OpenCode calls from about 1s to about 30s total.

Manual settings refresh works because it runs after startup contention is gone and uses `force: true`, which creates fresh OpenCode runtime/server state. The same OpenCode provider refreshes then complete in about 1.7s-2.2s.

The daemon does not auto-retry error snapshots. A failed provider snapshot is cached as `status: "error"` until an explicit refresh resets it to loading.

## Follow-up: Normal Copied-Home Startup Check

I later reran a normal dev-daemon startup against a fresh copy of the same Paseo home metadata and drove the app startup request path:

```text
fetchWorkspaces
fetchAgents
getProvidersSnapshot(home scope)
getProvidersSnapshot(first workspace scope)
```

That run did not reproduce the 30s OpenCode timeout.

```text
home scope:
  OpenCode ready at ~8s
  availability: 1.6s
  fetch total: 5.2s

first workspace scope:
  OpenCode ready at ~26s
  availability: 2.0s
  fetch total: 15.4s
```

The slowest OpenCode operation in that successful run was the workspace-scoped `/provider` response body read: `13.6s`. The daemon log had no `Timed out refreshing OpenCode` entry and no OpenCode provider snapshot failure.

This means the timeout is reproducible under the heavier multi-scope startup contention captured below, but it is not guaranteed on every copied-home dev startup.

## Reproduction Used

The user's correction was right: the useful reproduction is not a random isolated home. It must match `dev.sh` worktree behavior.

Relevant scripts:

- `scripts/dev.sh`
- `scripts/dev-daemon.sh`
- `scripts/dev-home.sh`

`dev-home.sh` only seeds this metadata into the dev home:

```text
agents/**/*.json
projects/**/*.json
config.json
```

It does not copy `chat`, `loops`, `schedules`, sockets, pid files, logs, or worktree contents.

I ran a separate daemon, not the main daemon:

```text
PASEO_HOME=/var/folders/xl/kkk9drfd3ms_t8x7rmy4z6900000gn/T/paseo-devseed.Wms6pi
PASEO_LISTEN=127.0.0.1:51116
PASEO_LOG_LEVEL=trace
```

Startup facts:

```text
18:13:39.552 Agent storage initialized: 712ms
18:13:39.559 Workspace registries bootstrapped: 719ms
18:13:39.961 Agent registry loaded: 4851 records
18:13:39.972 Server listening: http://127.0.0.1:51116
```

The probe then connected four client sessions and requested:

- workspaces
- active agents
- provider snapshots for home, paseo, and blankpage/editor

Client-visible result:

```text
18:14:30.263 /Users/moboudra/dev/blankpage/editor opencode error:
  OpenCode app.agents timed out after 10s

18:14:41.687 /Users/moboudra/dev/paseo opencode error:
  Timed out refreshing OpenCode after 30000ms

18:14:41.688 /Users/moboudra opencode error:
  Timed out refreshing OpenCode after 30000ms
```

## Exact OpenCode Timeline

OpenCode snapshot requests began at `18:14:10`.

Availability checks:

```text
18:14:10.780 opencode availability start for /Users/moboudra
18:14:10.787 opencode availability start for /Users/moboudra/dev/paseo
18:14:10.800 opencode availability start for /Users/moboudra/dev/blankpage/editor

18:14:11.363 paseo availability complete: 576ms
18:14:11.376 home availability complete: 597ms
18:14:11.391 blankpage availability complete: 591ms
```

OpenCode server acquisition:

```text
18:14:11.364 OpenCode server spawn start: opencode serve --port 56376
18:14:19.926 OpenCode server listening after 8562ms
```

Six SDK calls were then issued:

```text
18:14:19.931 GET /provider directory=/Users/moboudra/dev/paseo
18:14:19.931 GET /agent    directory=/Users/moboudra/dev/paseo
18:14:19.931 GET /provider directory=/Users/moboudra
18:14:19.931 GET /agent    directory=/Users/moboudra
18:14:19.931 GET /provider directory=/Users/moboudra/dev/blankpage/editor
18:14:19.936 GET /agent    directory=/Users/moboudra/dev/blankpage/editor
```

Why six:

| Cwd                                    | Why that scope exists                                      | Model call                              | Mode call                         |
| -------------------------------------- | ---------------------------------------------------------- | --------------------------------------- | --------------------------------- |
| `/Users/moboudra`                      | home/settings provider snapshot                            | `client.provider.list()` -> `/provider` | `client.app.agents()` -> `/agent` |
| `/Users/moboudra/dev/paseo`            | workspace-scoped provider snapshot for the Paseo workspace | `client.provider.list()` -> `/provider` | `client.app.agents()` -> `/agent` |
| `/Users/moboudra/dev/blankpage/editor` | workspace/agent cwd snapshot for blankpage/editor          | `client.provider.list()` -> `/provider` | `client.app.agents()` -> `/agent` |

Multiple clients can request the same snapshot scope during startup, but non-forced provider loads are deduped by `(cwd, provider)`. Different cwd scopes are separate loads. Three cwd scopes times two OpenCode SDK calls each is the six OpenCode calls in this repro.

Headers arrived before the 30s timeout:

| Call        | Cwd                             | Headers after request |
| ----------- | ------------------------------- | --------------------- |
| `/provider` | `/Users/moboudra`               | 6.462s                |
| `/agent`    | `/Users/moboudra`               | 6.681s                |
| `/agent`    | `/Users/moboudra/dev/paseo`     | 6.681s                |
| `/provider` | `/Users/moboudra/dev/paseo`     | 8.192s                |
| `/provider` | `/Users/moboudra/dev/blankpage` | 8.654s                |
| `/agent`    | `/Users/moboudra/dev/blankpage` | 8.649s                |

But body consumption and completion lagged:

```text
18:14:29.380 /agent home complete, total app.agents duration 9450ms
18:14:29.813 /agent paseo complete, total app.agents duration 9883ms
18:14:30.263 /agent blankpage timed out at 10s
18:14:31.332 /agent blankpage body finally finished, after the 10s app.agents timeout

18:14:41.687 paseo snapshot outer 30s timeout fires
18:14:41.688 home snapshot outer 30s timeout fires

18:14:43.593 /provider home completes, provider.list duration 23664ms, total listModels 32218ms
18:14:43.798 /provider blankpage completes, provider.list duration 23868ms, total listModels 32411ms
18:14:43.839 /provider paseo completes, provider.list duration 23911ms, total listModels 32476ms
```

The useful `/provider` results arrived about 1.9s-2.2s after the snapshot manager had already marked home and paseo as failed.

## Why Settings Refresh Works

After the daemon settled, I ran the same refresh path through the daemon on port `51116`, using `refreshProvidersSnapshot({ providers: ["opencode"] })`.

Results:

```text
home refresh:
  total: 2165ms
  status: ready
  models: 409
  modes: 5

/Users/moboudra/dev/paseo refresh:
  total: 1675ms
  status: ready
  models: 409
  modes: 5

/Users/moboudra/dev/blankpage/editor refresh:
  total: 1794ms
  status: ready
  models: 409
  modes: 5
```

Trace details for the manual-style refresh:

```text
OpenCode server acquisition: 708ms-1291ms
/agent completion: 433ms-592ms after request start
/provider completion: 524ms-618ms after request start
```

That proves the startup failure is not bad credentials, not a permanently wedged OpenCode install, and not OpenCode generally taking more than 30s. It is startup timing and contention.

## Minimal OpenCode-Only Repros

### OpenCode Only, No Daemon, No Artificial Load

I started a fresh `opencode serve`, waited for stdout `listening on`, then issued the same six HTTP calls concurrently:

```text
GET /provider?directory=/Users/moboudra
GET /agent?directory=/Users/moboudra
GET /provider?directory=/Users/moboudra/dev/paseo
GET /agent?directory=/Users/moboudra/dev/paseo
GET /provider?directory=/Users/moboudra/dev/blankpage/editor
GET /agent?directory=/Users/moboudra/dev/blankpage/editor
```

Three runs:

| Run | `opencode serve` ready | All six calls complete |
| --- | ---------------------- | ---------------------- |
| 1   | 1376ms                 | 1295ms                 |
| 2   | 906ms                  | 1050ms                 |
| 3   | 939ms                  | 898ms                  |

Slowest individual call in those runs:

```text
/provider /Users/moboudra/dev/paseo: 1270ms total
/agent /Users/moboudra/dev/blankpage/editor: 1251ms total
```

So six concurrent OpenCode calls alone are not the bug.

### OpenCode Only Plus External Git Storm, No Daemon

I then ran the same OpenCode-only six-call test while an external shell spawned repeated git commands across the same real workspaces/worktrees. This did not use the Paseo daemon.

Result:

```text
opencode serve ready: 15479ms
all six OpenCode calls complete: 15176ms after server ready
combined cold-start + calls: about 30655ms
```

Individual calls under the external git storm:

| Call        | Cwd                                    |   Total |
| ----------- | -------------------------------------- | ------: |
| `/provider` | `/Users/moboudra`                      | 10684ms |
| `/agent`    | `/Users/moboudra`                      | 10767ms |
| `/provider` | `/Users/moboudra/dev/paseo`            | 13220ms |
| `/agent`    | `/Users/moboudra/dev/paseo`            | 13147ms |
| `/provider` | `/Users/moboudra/dev/blankpage/editor` | 14675ms |
| `/agent`    | `/Users/moboudra/dev/blankpage/editor` | 15038ms |

This is the daemon-free minimal evidence that process/filesystem contention can push the same OpenCode cold-start + six-call workload to the same 30s boundary.

## Why It Does Not Retry

`ProviderSnapshotManager.getSnapshot()` only starts background warmup for:

- no existing snapshot
- missing providers
- entries still in `loading` with no active load

When refresh fails, `refreshProvider()` stores:

```text
status: "error"
error: "Timed out refreshing OpenCode after 30000ms"
```

An `error` entry is not treated as stale/loading by `getSnapshot()`, so normal reads keep returning the cached error.

Settings refresh calls `refresh_providers_snapshot_request`, which routes to:

```text
refreshSettingsSnapshot()
clearCachedProviders()
resetSnapshotToLoading()
refreshProviders(... force: true)
```

That is why you have to force a manual refresh.

## Git Work During The Repro

This is not the final optimization report, but it matters for the timeout because it overlaps exactly with OpenCode response handling.

Total git commands in the dev-style copied-home daemon log:

```text
632 spawned
632 closed
```

Top cwd counts:

| Count | Cwd                                                                                   |
| ----: | ------------------------------------------------------------------------------------- |
|    44 | `/Users/moboudra/.paseo/worktrees/1luy0po7/merry-ladybug`                             |
|    44 | `/Users/moboudra/.paseo/worktrees/1luy0po7/hopeful-eel`                               |
|    44 | `/Users/moboudra/.paseo/worktrees/1luy0po7/fix-compaction-cancel-loading`             |
|    44 | `/Users/moboudra/.paseo/worktrees/1luy0po7/fix-archive-worktree-session-history`      |
|    44 | `/Users/moboudra/.paseo/worktrees/0vpo9h4b/breezy-toad`                               |
|    36 | `/Users/moboudra/.paseo/worktrees/steering-policy-refactor-detached`                  |
|    36 | `/Users/moboudra/.paseo/worktrees/1luy0po7/integration-session-mcp-command-stack`     |
|    36 | `/Users/moboudra/.paseo/worktrees/1luy0po7/fix-provider-diagnostic-binary-resolution` |
|    36 | `/Users/moboudra/.paseo/worktrees/1luy0po7/feat-voice-runtime-on-demand`              |
|    36 | `/Users/moboudra/.paseo/worktrees/1luy0po7/feat-find-in-pane`                         |
|    36 | `/Users/moboudra/.paseo/worktrees/1luy0po7/epic-paseo-client-sdk`                     |
|    24 | `/Users/moboudra/dev/paseo`                                                           |
|    24 | `/Users/moboudra/dev/blankpage/editor`                                                |
|    24 | `/Users/moboudra/dev/faro/main`                                                       |
|    24 | `/Users/moboudra/dev/konbert/web`                                                     |
|    24 | `/Users/moboudra/dev/paseo-cloud`                                                     |

In the exact OpenCode pressure window, `18:14:19` through `18:14:43`, there were:

```text
142 git command spawns
150 git command closes
```

The main repeated command shapes were:

```text
76  git rev-parse --show-toplevel
72  git status --porcelain
72  git show-ref --verify --quiet refs/remotes/origin/main
72  git show-ref --verify --quiet refs/heads/main
16  git config --get branch.main.remote
16  git config --get branch.main.merge
16  git rev-list --count main..origin/main
16  git rev-list --count origin/main..main
```

## Original `log.txt` Alignment

The original startup showed the same home and paseo outer timeout shape:

```text
16:04:22.466 /Users/moboudra/dev/paseo:
  Timed out refreshing OpenCode after 30000ms

16:04:22.482 /Users/moboudra:
  Timed out refreshing OpenCode after 30000ms
```

The original logs did not include SDK fetch/header/body timing, so they could only show the wrapper-level timeout. The dev-style copied-home reproduction with instrumentation now shows the missing link: the `/provider` calls completed just after the 30s snapshot budget.

## Files Instrumented For Diagnosis

Temporary trace instrumentation was added to:

- `packages/server/src/server/agent/provider-snapshot-manager.ts`
- `packages/server/src/server/agent/providers/opencode-agent.ts`
- `packages/server/src/server/agent/providers/opencode/runtime.ts`
- `packages/server/src/server/agent/providers/opencode/server-manager.ts`

The instrumentation is behavior-neutral and only emits trace logs.
