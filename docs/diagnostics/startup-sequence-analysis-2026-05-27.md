# Daemon Startup Sequence Analysis - 2026-05-27

Source log: `log.txt` at repository root.

Scope: current sliced startup log, starting at daemon worker startup and ending after workspace registry reconciliation and the first OpenCode heartbeat.

This report is descriptive only. It does not propose optimizations.

## Executive Summary

The daemon becomes ready quickly, then does a heavy post-listen startup pass driven by reconnecting clients and workspace/app hydration.

- Worker start: `16:03:46.678`, line 1.
- Server listening: `16:03:48.285`, line 47, elapsed `602ms`.
- First client hello: `16:03:50.285`, line 66.
- Workspace registries reconciled: `16:04:33.666`, line 1777, elapsed `45983ms`.

The startup shape is therefore:

- Daemon listen readiness: about `0.6s`.
- Client reconnect plus workspace/app/provider hydration: about `45s`.
- No git commands after workspace registry reconciliation in this slice.

## Method

I parsed structured trace lines from `log.txt`, especially:

- `Git command closed`
- `agent.session.inbound`
- `agent.session.outbound`
- `ws_slow_request`
- provider snapshot warnings
- provider resume events

Important limitation: git command logs do not carry a websocket request id, so per-request attribution is inferred from timing and server code paths. Per-workspace git counts, command shapes, durations, and failures are exact for this log.

Relevant code paths checked:

- `packages/server/src/server/session.ts`
  - `fetch_workspaces_request` calls `syncWorkspaceGitObservers(payload.entries)`.
  - `checkout_status_request` calls `workspaceGitService.getSnapshot(resolvedCwd)`.
  - `checkout_pr_status_request` calls `workspaceGitService.getSnapshot(cwd)`.
- `packages/server/src/server/workspace-git-service.ts`
  - checkout snapshot/root resolution uses `git rev-parse --show-toplevel`.
  - snapshot refresh collects dirty state, upstream/ahead/behind, ref existence, and base divergence.
- `packages/app/src/contexts/session-context.tsx`
  - initial workspace hydration calls `client.fetchWorkspaces({ sort: activity_at desc, subscribe, page limit 200 })`.
- `packages/app/src/hooks/use-sidebar-workspaces-list.ts`
  - sidebar workspace refresh also calls `client.fetchWorkspaces({ sort: activity_at desc, page limit 200 })`.

## Startup Timeline

| time           | line | event                                                              |
| -------------- | ---: | ------------------------------------------------------------------ |
| `16:03:46.678` |    1 | `DaemonRunner` starts daemon worker                                |
| `16:03:47.683` |    4 | worker spawned                                                     |
| `16:03:47.684` |    6 | daemon keypair loaded                                              |
| `16:03:48.281` |   44 | bootstrap complete, ready to listen                                |
| `16:03:48.285` |   47 | server listening on `0.0.0.0:6767`                                 |
| `16:03:50.274` |   60 | first websocket awaiting hello                                     |
| `16:03:50.285` |   66 | first client connected via hello                                   |
| `16:04:22.466` |  987 | OpenCode provider snapshot timeout for `/Users/moboudra/dev/paseo` |
| `16:04:22.482` | 1002 | OpenCode provider snapshot timeout for `/Users/moboudra`           |
| `16:04:24.183` | 1201 | OpenCode provider subscribe starts                                 |
| `16:04:24.183` | 1202 | OpenCode provider subscribe ready                                  |
| `16:04:24.306` | 1214 | OpenCode server connected event                                    |
| `16:04:25.933` | 1321 | OpenCode agent resumed from persistence                            |
| `16:04:33.666` | 1777 | workspace registries reconciled                                    |
| `16:04:34.197` | 1783 | OpenCode heartbeat                                                 |
| `16:04:44.200` | 1789 | OpenCode heartbeat                                                 |

## Git Command Totals

Total git commands in the sliced startup: `444`.

| phase                           | commands | failures | summed process time |
| ------------------------------- | -------: | -------: | ------------------: |
| daemon bootstrap before listen  |       13 |        4 |               445ms |
| post-listen before first client |        1 |        0 |              2020ms |
| client reconnect + reconcile    |      430 |       71 |            120813ms |
| after reconcile                 |        0 |        0 |                 0ms |
| total                           |      444 |       75 |            123278ms |

Summed process time is not wall-clock time. Many commands overlap.

## Git Command Categories

| category                                             | commands | failures | summed process time | max duration |
| ---------------------------------------------------- | -------: | -------: | ------------------: | -----------: |
| ahead/behind: `rev-list --count ...`                 |      115 |       30 |             35815ms |       1557ms |
| refs: `show-ref --verify --quiet ...`                |       86 |        2 |             14680ms |       1303ms |
| upstream config: `config --get branch.*`             |       85 |       13 |             26437ms |       1624ms |
| root detection: `rev-parse --show-toplevel`          |       80 |       30 |             24164ms |       1426ms |
| dirty status: `status --porcelain`                   |       50 |        0 |             12670ms |       2020ms |
| base divergence: `rev-list --left-right --count ...` |       28 |        0 |              9512ms |       1085ms |

What those categories mean in the app:

- Root detection: determine whether a cwd is inside a git repo and find its checkout root.
- Dirty status: show dirty/clean workspace state.
- Upstream config and ahead/behind: show branch tracking and sync state.
- Ref existence and base divergence: compare checkout branch against candidate base refs for checkout/PR status.

## Per-Workspace Git Work

Columns:

- `phase`: `pre/warm/reconnect/after`
- `cats`: `root/dirty/upstream/ahead/refs/base/other`
- `total_ms`: summed process time for that workspace

| workspace                                                               | cmds | fail | phase      | cats              | total_ms | max_ms | window                      | failing command shapes                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------- | ---: | ---: | ---------- | ----------------- | -------: | -----: | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.paseo/worktrees/1luy0po7/fix-compaction-cancel-loading`             |   33 |    9 | `0/0/33/0` | `3/3/3/9/12/3/0`  |     8255 |   1460 | `16:03:52.908-16:04:24.019` | `3x config --get branch.fix-compaction-cancel-loading.remote`; `3x rev-list --count fix-compaction-cancel-loading..origin/fix-compaction-cancel-loading`; `3x rev-list --count origin/fix-compaction-cancel-loading..fix-compaction-cancel-loading`                                           |
| `~/.paseo/worktrees/1luy0po7/hopeful-eel`                               |   33 |    9 | `0/0/33/0` | `3/3/3/9/12/3/0`  |     8468 |   1544 | `16:03:53.245-16:04:27.334` | `3x config --get branch.feat/markdown-annotations.remote`; `3x rev-list --count feat/markdown-annotations..origin/feat/markdown-annotations`; `3x rev-list --count origin/feat/markdown-annotations..feat/markdown-annotations`                                                               |
| `~/.paseo/worktrees/1luy0po7/merry-ladybug`                             |   33 |    9 | `0/0/33/0` | `3/3/3/9/12/3/0`  |     7154 |   1099 | `16:03:53.696-16:04:29.644` | `3x config --get branch.feat/mcp-configuration.remote`; `3x rev-list --count feat/mcp-configuration..origin/feat/mcp-configuration`; `3x rev-list --count origin/feat/mcp-configuration..feat/mcp-configuration`                                                                              |
| `~/dev/paseo`                                                           |   30 |    0 | `2/0/28/0` | `5/5/10/10/0/0/0` |     7457 |   1624 | `16:03:48.171-16:04:27.284` |                                                                                                                                                                                                                                                                                               |
| `~/.paseo/worktrees/0vpo9h4b/dazzling-duck`                             |   27 |    0 | `0/0/27/0` | `3/3/6/6/6/3/0`   |     7617 |   1269 | `16:03:51.918-16:04:23.971` |                                                                                                                                                                                                                                                                                               |
| `~/.paseo/worktrees/1luy0po7/epic-paseo-client-sdk`                     |   27 |    0 | `0/0/27/0` | `3/3/6/6/6/3/0`   |     7428 |   1426 | `16:03:52.445-16:04:23.991` |                                                                                                                                                                                                                                                                                               |
| `~/.paseo/worktrees/1luy0po7/fix-provider-diagnostic-binary-resolution` |   27 |    0 | `0/0/27/0` | `3/3/6/6/6/3/0`   |     7764 |   1091 | `16:03:52.681-16:04:23.971` |                                                                                                                                                                                                                                                                                               |
| `~/dev/emdash`                                                          |   22 |    6 | `0/0/22/0` | `2/2/2/6/8/2/0`   |     3031 |    453 | `16:04:27.351-16:04:29.583` | `2x config --get branch.heads/main.remote`; `2x rev-list --count heads/main..origin/heads/main`; `2x rev-list --count origin/heads/main..heads/main`                                                                                                                                          |
| `~/dev/opencode`                                                        |   22 |    4 | `0/0/22/0` | `2/2/2/6/8/2/0`   |     2279 |    313 | `16:04:24.058-16:04:24.970` | `2x rev-list --count ecosystem-paseo..origin/ecosystem-paseo`; `2x rev-list --count origin/ecosystem-paseo..ecosystem-paseo`                                                                                                                                                                  |
| `~/.paseo/worktrees/1luy0po7/integration-session-mcp-command-stack`     |   18 |    0 | `0/0/18/0` | `3/3/6/6/0/0/0`   |     7467 |   1242 | `16:03:53.781-16:04:23.971` |                                                                                                                                                                                                                                                                                               |
| `~/dev/blankpage/editor`                                                |   18 |    0 | `2/0/16/0` | `3/3/6/6/0/0/0`   |     2418 |    520 | `16:03:48.174-16:04:26.411` |                                                                                                                                                                                                                                                                                               |
| `~/dev/konbert/web`                                                     |   18 |    0 | `1/1/16/0` | `3/3/6/6/0/0/0`   |     7324 |   2020 | `16:03:48.190-16:04:23.685` |                                                                                                                                                                                                                                                                                               |
| `~/dev/openchamber`                                                     |   12 |    0 | `0/0/12/0` | `2/2/4/4/0/0/0`   |     1554 |    336 | `16:04:27.399-16:04:29.616` |                                                                                                                                                                                                                                                                                               |
| `~/dev/superset`                                                        |   12 |    0 | `0/0/12/0` | `2/2/4/4/0/0/0`   |     1019 |    215 | `16:04:27.341-16:04:29.617` |                                                                                                                                                                                                                                                                                               |
| `~/dev/t3code`                                                          |   12 |    0 | `0/0/12/0` | `2/2/4/4/0/0/0`   |     2761 |    588 | `16:04:27.356-16:04:29.603` |                                                                                                                                                                                                                                                                                               |
| `~/.paseo/worktrees/0vpo9h4b/breezy-toad`                               |   11 |    5 | `0/0/11/0` | `1/1/1/3/4/1/0`   |     6465 |   1290 | `16:03:51.307-16:04:18.112` | `1x config --get branch.fix/user-delete-dark-mode.remote`; `1x rev-list --count fix/user-delete-dark-mode..origin/fix/user-delete-dark-mode`; `1x rev-list --count origin/fix/user-delete-dark-mode..fix/user-delete-dark-mode`; `2x show-ref --verify --quiet refs/remotes/origin/my-branch` |
| `~/.paseo/worktrees/1luy0po7/fix-archive-worktree-session-history`      |   11 |    3 | `0/0/11/0` | `1/1/1/3/4/1/0`   |     4303 |    757 | `16:03:52.539-16:04:19.011` | `1x config --get branch.fix-archive-worktree-session-history.remote`; `1x rev-list --count fix-archive-worktree-session-history..origin/fix-archive-worktree-session-history`; `1x rev-list --count origin/fix-archive-worktree-session-history..fix-archive-worktree-session-history`        |
| `~/.paseo/worktrees/0vpo9h4b/codex-github-mention-implement-db-garbage` |    9 |    0 | `0/0/9/0`  | `1/1/2/2/2/1/0`   |     4986 |   1005 | `16:03:51.261-16:04:16.878` |                                                                                                                                                                                                                                                                                               |
| `~/.paseo/worktrees/1luy0po7/feat-find-in-pane`                         |    9 |    0 | `0/0/9/0`  | `1/1/2/2/2/1/0`   |     5273 |   1130 | `16:03:52.391-16:04:17.682` |                                                                                                                                                                                                                                                                                               |
| `~/.paseo/worktrees/1luy0po7/feat-voice-runtime-on-demand`              |    9 |    0 | `0/0/9/0`  | `1/1/2/2/2/1/0`   |     5176 |    839 | `16:03:52.110-16:04:18.254` |                                                                                                                                                                                                                                                                                               |
| `~/.paseo/worktrees/steering-policy-refactor-detached`                  |    9 |    0 | `0/0/9/0`  | `1/1/2/2/2/1/0`   |     5993 |   1243 | `16:03:53.984-16:04:17.673` |                                                                                                                                                                                                                                                                                               |
| `~/dev/faro/main`                                                       |    6 |    0 | `2/0/4/0`  | `1/1/2/2/0/0/0`   |     4964 |   1603 | `16:03:48.168-16:04:03.748` |                                                                                                                                                                                                                                                                                               |
| `~/dev/paseo-cloud`                                                     |    6 |    0 | `2/0/4/0`  | `1/1/2/2/0/0/0`   |     2123 |   1154 | `16:03:48.159-16:03:56.377` |                                                                                                                                                                                                                                                                                               |
| `~/dev/assistant`                                                       |    3 |    3 | `1/0/2/0`  | `3/0/0/0/0/0/0`   |       85 |     29 | `16:03:48.165-16:04:24.048` | `3x rev-parse --show-toplevel`                                                                                                                                                                                                                                                                |
| `~/dev/benchmark/dashboard-2026-05-25/review`                           |    3 |    3 | `1/0/2/0`  | `3/0/0/0/0/0/0`   |      224 |    105 | `16:03:48.197-16:04:26.560` | `3x rev-parse --show-toplevel`                                                                                                                                                                                                                                                                |
| `~/dev/research/orchestrator-worker`                                    |    3 |    3 | `1/0/2/0`  | `3/0/0/0/0/0/0`   |      285 |    144 | `16:03:48.194-16:04:26.575` | `3x rev-parse --show-toplevel`                                                                                                                                                                                                                                                                |
| `/tmp`                                                                  |    2 |    2 | `0/0/2/0`  | `2/0/0/0/0/0/0`   |      113 |     77 | `16:04:27.388-16:04:27.471` | `2x rev-parse --show-toplevel`                                                                                                                                                                                                                                                                |
| `~/dev`                                                                 |    2 |    2 | `0/0/2/0`  | `2/0/0/0/0/0/0`   |       86 |     58 | `16:04:27.384-16:04:27.457` | `2x rev-parse --show-toplevel`                                                                                                                                                                                                                                                                |
| `~/dev/benchmark/dashboard-2026-05-25/01-claude-opus`                   |    2 |    2 | `0/0/2/0`  | `2/0/0/0/0/0/0`   |      216 |    185 | `16:04:26.525-16:04:26.543` | `2x rev-parse --show-toplevel`                                                                                                                                                                                                                                                                |
| `~/dev/benchmark/dashboard-2026-05-25/02-codex-gpt55`                   |    2 |    2 | `0/0/2/0`  | `2/0/0/0/0/0/0`   |       98 |     68 | `16:04:26.353-16:04:26.554` | `2x rev-parse --show-toplevel`                                                                                                                                                                                                                                                                |
| `~/dev/benchmark/dashboard-2026-05-25/03-opencode-zai-glm51`            |    2 |    2 | `0/0/2/0`  | `2/0/0/0/0/0/0`   |      209 |    158 | `16:04:26.512-16:04:26.576` | `2x rev-parse --show-toplevel`                                                                                                                                                                                                                                                                |
| `~/dev/benchmark/dashboard-2026-05-25/04-opencode-zen-minimax27`        |    2 |    2 | `0/0/2/0`  | `2/0/0/0/0/0/0`   |      148 |    101 | `16:04:26.431-16:04:26.549` | `2x rev-parse --show-toplevel`                                                                                                                                                                                                                                                                |
| `~/dev/benchmark/dashboard-2026-05-25/05-opencode-zen-kimi26`           |    2 |    2 | `0/0/2/0`  | `2/0/0/0/0/0/0`   |      231 |    172 | `16:04:26.517-16:04:26.577` | `2x rev-parse --show-toplevel`                                                                                                                                                                                                                                                                |
| `~/dev/benchmark/dashboard-2026-05-25/06-opencode-or-deepseek4pro`      |    2 |    2 | `0/0/2/0`  | `2/0/0/0/0/0/0`   |       93 |     73 | `16:04:27.365-16:04:27.380` | `2x rev-parse --show-toplevel`                                                                                                                                                                                                                                                                |
| `~/dev/benchmark/dashboard-2026-05-25/07-opencode-zen-gemini35flash`    |    2 |    2 | `0/0/2/0`  | `2/0/0/0/0/0/0`   |       78 |     66 | `16:04:27.363-16:04:27.375` | `2x rev-parse --show-toplevel`                                                                                                                                                                                                                                                                |
| `~/dev/benchmark/dashboard-2026-05-25/08-opencode-zen-gpt55`            |    2 |    2 | `0/0/2/0`  | `2/0/0/0/0/0/0`   |      120 |     65 | `16:04:27.359-16:04:27.430` | `2x rev-parse --show-toplevel`                                                                                                                                                                                                                                                                |
| `~/dev/assistant/game`                                                  |    1 |    1 | `1/0/0/0`  | `1/0/0/0/0/0/0`   |       13 |     13 | `16:03:48.155-16:03:48.155` | `1x rev-parse --show-toplevel`                                                                                                                                                                                                                                                                |

## Git Failure Shape

There were 75 nonzero git exits.

Most failures were not timeouts. They were expected probe failures:

- Non-repo checks: `rev-parse --show-toplevel` fails for paths that are not git repositories.
- Missing upstream config: `config --get branch.<branch>.remote` fails for branches without configured upstream.
- Missing remote branch graph: `rev-list --count <branch>..origin/<branch>` fails when the remote branch/ref does not exist.
- Missing ref checks: `show-ref --verify --quiet refs/remotes/origin/my-branch` fails when a candidate ref does not exist.

The `~/dev/opencode` git failures are branch graph probes for `ecosystem-paseo` versus `origin/ecosystem-paseo`, not OpenCode provider startup failures.

## Inbound Client Work

Inbound session messages during the startup window:

| request                           | count |
| --------------------------------- | ----: |
| `client_heartbeat`                |    19 |
| `checkout_pr_status_request`      |    18 |
| `fetch_agents_request`            |    11 |
| `fetch_workspaces_request`        |     9 |
| `get_providers_snapshot_request`  |     9 |
| `project_icon_request`            |     9 |
| `fetch_agent_timeline_request`    |     7 |
| `clear_agent_attention`           |     6 |
| `list_terminals_request`          |     5 |
| `subscribe_terminals_request`     |     5 |
| `list_available_editors_request`  |     2 |
| `subscribe_checkout_diff_request` |     2 |
| `checkout_status_request`         |     1 |
| `fetch_agent_request`             |     1 |
| `file_explorer_request`           |     1 |
| `read_project_config_request`     |     1 |
| `workspace_setup_status_request`  |     1 |

Inbound by client:

| client                                                      | count | top work                                                                                                                                                                                                           |
| ----------------------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Electron `cid_d555...`, origin `http://localhost:8082`      |    68 | `checkout_pr_status_request:18`, `project_icon_request:9`, `clear_agent_attention:6`, `fetch_agent_timeline_request:4`, `fetch_workspaces_request:3`, `fetch_agents_request:3`, `get_providers_snapshot_request:3` |
| HeadlessChrome `cid_d39...`, origin `http://localhost:8081` |    13 | `client_heartbeat:4`, `fetch_workspaces_request:2`, `fetch_agents_request:2`, `get_providers_snapshot_request:2`                                                                                                   |
| local web `cid_a2b...`, origin `http://localhost:6767`      |    13 | `client_heartbeat:4`, `fetch_workspaces_request:2`, `fetch_agents_request:2`, `get_providers_snapshot_request:2`                                                                                                   |
| Android `cid_24c...`, origin `http://10.0.2.2:6767`         |    11 | `client_heartbeat:2`, `fetch_workspaces_request:2`, `fetch_agents_request:2`, `get_providers_snapshot_request:2`                                                                                                   |
| `cid_70d...`, host `0.0.0.0:6767`                           |     2 | `fetch_agents_request:2`                                                                                                                                                                                           |

## Outbound Client Work

Outbound session messages during the startup window:

| message                            | count |
| ---------------------------------- | ----: |
| `providers_snapshot_update`        |   129 |
| `workspace_update`                 |    81 |
| `checkout_status_update`           |    76 |
| `agent_update`                     |    47 |
| `checkout_pr_status_response`      |    18 |
| `fetch_agents_response`            |    11 |
| `fetch_workspaces_response`        |     9 |
| `get_providers_snapshot_response`  |     9 |
| `project_icon_response`            |     9 |
| `fetch_agent_timeline_response`    |     7 |
| `list_terminals_response`          |     5 |
| `terminals_changed`                |     5 |
| `list_available_editors_response`  |     2 |
| `subscribe_checkout_diff_response` |     2 |
| `checkout_status_response`         |     1 |
| `fetch_agent_response`             |     1 |
| `file_explorer_response`           |     1 |
| `read_project_config_response`     |     1 |
| `workspace_setup_status_response`  |     1 |

Provider snapshot updates were large and repeated:

- Around lines 982-986: five `providers_snapshot_update` messages, each `215932` bytes.
- Around lines 997-1001: five `providers_snapshot_update` messages, each `215898` bytes.
- Around lines 1250-1254: five `providers_snapshot_update` messages, each `414735` bytes.

## Slow Requests

Slow requests logged during startup:

| time           |                           request | duration | client                | line |
| -------------- | --------------------------------: | -------: | --------------------- | ---: |
| `16:04:29.702` |    `fetch_agent_timeline_request` |  39372ms | HeadlessChrome        | 1767 |
| `16:04:29.702` |    `fetch_agent_timeline_request` |  39212ms | Electron              | 1768 |
| `16:04:29.702` |    `fetch_agent_timeline_request` |  38914ms | local web             | 1769 |
| `16:04:33.665` |      `checkout_pr_status_request` |  20181ms | Electron              | 1776 |
| `16:04:08.109` | `subscribe_checkout_diff_request` |  17618ms | Electron              |  565 |
| `16:04:29.702` |    `fetch_agent_timeline_request` |  16216ms | Electron              | 1770 |
| `16:04:06.624` |    `fetch_agent_timeline_request` |  16134ms | Electron              |  524 |
| `16:04:29.396` |      `checkout_pr_status_request` |  15911ms | Electron              | 1671 |
| `16:04:29.256` |      `checkout_pr_status_request` |  15772ms | Electron              | 1651 |
| `16:04:29.149` |      `checkout_pr_status_request` |  15665ms | Electron              | 1638 |
| `16:04:29.054` |      `checkout_pr_status_request` |  15569ms | Electron              | 1628 |
| `16:04:28.932` |      `checkout_pr_status_request` |  15448ms | Electron              | 1611 |
| `16:04:28.809` |      `checkout_pr_status_request` |  15324ms | Electron              | 1601 |
| `16:04:28.672` |      `checkout_pr_status_request` |  15188ms | Electron              | 1582 |
| `16:04:28.555` |      `checkout_pr_status_request` |  15071ms | Electron              | 1567 |
| `16:04:28.421` |      `checkout_pr_status_request` |  14936ms | Electron              | 1556 |
| `16:04:28.323` |      `checkout_pr_status_request` |  14839ms | Electron              | 1549 |
| `16:04:28.324` |         `checkout_status_request` |  14839ms | Electron              | 1550 |
| `16:04:28.189` |      `checkout_pr_status_request` |  14705ms | Electron              | 1536 |
| `16:04:29.634` |            `fetch_agents_request` |  14590ms | `0.0.0.0:6767` client | 1759 |
| `16:04:28.006` |      `checkout_pr_status_request` |  14522ms | Electron              | 1526 |
| `16:04:27.628` |      `checkout_pr_status_request` |  14143ms | Electron              | 1496 |
| `16:04:27.061` |      `checkout_pr_status_request` |  13576ms | Electron              | 1405 |
| `16:04:29.645` |            `fetch_agents_request` |  13384ms | `0.0.0.0:6767` client | 1762 |
| `16:04:02.812` |    `fetch_agent_timeline_request` |  12321ms | Electron              |  440 |
| `16:04:25.740` |      `checkout_pr_status_request` |  12256ms | Electron              | 1309 |
| `16:04:25.352` |      `checkout_pr_status_request` |  11867ms | Electron              | 1296 |
| `16:04:04.217` |    `fetch_agent_timeline_request` |  11751ms | Android               |  462 |
| `16:04:25.155` |      `checkout_pr_status_request` |  11671ms | Electron              | 1284 |
| `16:04:23.196` |             `fetch_agent_request` |   9711ms | Electron              | 1070 |
| `16:04:17.563` |            `project_icon_request` |   4079ms | Electron              |  877 |
| `16:03:53.022` |  `list_available_editors_request` |   2533ms | Electron              |  254 |
| `16:04:15.703` |            `project_icon_request` |   2218ms | Electron              |  824 |
| `16:04:15.696` |            `project_icon_request` |   2211ms | Electron              |  822 |
| `16:04:15.694` |            `project_icon_request` |   2209ms | Electron              |  820 |
| `16:04:15.103` |           `file_explorer_request` |   1618ms | Electron              |  806 |
| `16:04:14.107` |          `list_terminals_request` |    621ms | Electron              |  764 |
| `16:03:50.945` |          `list_terminals_request` |    614ms | HeadlessChrome        |  156 |

The checkout PR requests are especially clustered: 18 Electron `checkout_pr_status_request` messages arrive together at `16:04:13.484`, lines 699-716. Their slow-request completions drain over the next ~20s, with `inflightRequests` dropping from 20 to 0.

## Provider Findings

### OpenCode

OpenCode provider snapshot refresh had two timeouts:

| time           | line | cwd                         | error                                         |
| -------------- | ---: | --------------------------- | --------------------------------------------- |
| `16:04:22.466` |  987 | `/Users/moboudra/dev/paseo` | `Timed out refreshing OpenCode after 30000ms` |
| `16:04:22.482` | 1002 | `/Users/moboudra`           | `Timed out refreshing OpenCode after 30000ms` |

These are provider snapshot failures, not OpenCode agent resume failures.

The persisted OpenCode agent did resume:

| time           | line | event                                                 |
| -------------- | ---: | ----------------------------------------------------- |
| `16:04:24.183` | 1201 | `provider.opencode.subscribe.start`                   |
| `16:04:24.183` | 1202 | `provider.opencode.subscribe.ready`                   |
| `16:04:24.306` | 1214 | raw event `server.connected`                          |
| `16:04:25.933` | 1321 | `Agent resumed from persistence`, provider `opencode` |
| `16:04:34.197` | 1783 | raw event `server.heartbeat`                          |
| `16:04:44.200` | 1789 | raw event `server.heartbeat`                          |

There are no `provider.opencode.subscribe.error` or OpenCode agent fatal errors in this slice.

OpenCode-related git:

- `~/dev/opencode` had 22 git commands.
- Four failed.
- The failed commands were branch graph probes for `ecosystem-paseo` versus `origin/ecosystem-paseo`.
- Those failures are git state/probe failures, not OpenCode provider process failures.

### Codex

Codex provider startup observations:

- `provider.codex.spawn` appears multiple times for provider snapshot/config discovery.
- A persisted Codex agent resumes successfully at `16:04:06.357`, line 518.
- Debug logs show failed reads of Codex saved config defaults, but these are debug-level and do not become provider startup warnings/errors in this slice.
- There are unhandled Codex trace event types such as remote-control/status and thread/goal status, but no Codex timeout or fatal provider startup failure in this slice.

### Claude

Claude agents resume successfully:

| time           | line | client   | agent                                  |
| -------------- | ---: | -------- | -------------------------------------- |
| `16:04:02.540` |  434 | Electron | `f884552a-1383-4dba-8583-7ae0b6a62353` |
| `16:04:03.772` |  456 | Android  | `0c89a057-05f2-4e23-9895-84c8e1952310` |

## What Work The App Asked For

The startup work visible in the app/server protocol is:

- Workspace list/sidebar hydration:
  - `fetch_workspaces_request`, 9 total.
  - This asks for the workspace list sorted by `activity_at desc`, usually page limit 200.
  - On the server this triggers workspace git observer sync and workspace update flushing.

- Agent list and agent detail hydration:
  - `fetch_agents_request`, 11 total.
  - `fetch_agent_request`, 1 total.
  - `fetch_agent_timeline_request`, 7 total.
  - Timeline requests are among the slowest requests in this slice.

- Checkout/PR status UI:
  - `checkout_pr_status_request`, 18 total, all Electron.
  - `checkout_status_request`, 1 total.
  - `subscribe_checkout_diff_request`, 2 total.
  - These correspond to git snapshot consumers and are clustered during Electron reconnect.

- Provider/model/mode UI:
  - `get_providers_snapshot_request`, 9 total.
  - `providers_snapshot_update`, 129 outbound updates.
  - OpenCode provider snapshot refresh times out twice during this flow.

- Workspace chrome:
  - `project_icon_request`, 9 total.
  - `file_explorer_request`, 1 total.

- Terminal panel:
  - `list_terminals_request`, 5 total.
  - `subscribe_terminals_request`, 5 total.
  - `terminals_changed`, 5 outbound updates.

- Attention state:
  - `clear_agent_attention`, 6 total.
  - Some failures appear while clearing attention for persisted agents, but these are not provider startup failures.

## Concrete Waste-Looking Work, Without Optimizing Yet

The log shows repeated work in these exact forms:

- 444 git commands total, but only 14 complete before the first client hello. The rest are post-listen startup/client hydration work.
- Several workspaces get repeated full checkout snapshot patterns:
  - three 33-command worktrees each get `3` root checks, `3` dirty checks, `3` upstream config probes, `9` ahead/behind probes, `12` ref checks, and `3` base divergence checks.
  - three 27-command worktrees each get `3` root checks, `3` dirty checks, `6` upstream config probes, `6` ahead/behind probes, `6` ref checks, and `3` base divergence checks.
  - `~/dev/paseo` gets `5` root checks, `5` dirty checks, `10` upstream config probes, and `10` ahead/behind probes.
- Electron sends 18 `checkout_pr_status_request` messages at the same timestamp, then they drain slowly over ~20s.
- Provider snapshot updates are broadcast very frequently: 129 outbound `providers_snapshot_update` messages, including large repeated payloads around 216KB and 415KB.
- OpenCode snapshot refresh times out twice after 30s, but the actual OpenCode agent connection/resume succeeds.

Again, this section names repeated work observed in the startup. It does not claim which repetition should be removed.
