# Git Snapshot Startup Reshaping - 2026-05-27

## What changed

The sidebar PR badge no longer has a special per-row fetch path. It is derived from the workspace snapshot, the same way the sidebar already gets branch/diff metadata.

```text
daemon startup / workspace subscription
  -> WorkspaceGitService.refreshSnapshot(cwd)
    -> getCheckoutSnapshotFacts(cwd)
    -> getCheckoutStatus(cwd, { facts })
    -> getCheckoutShortstat(cwd, { facts })
    -> getPullRequestStatus(cwd, github, ..., { facts })
    -> WorkspaceGitRuntimeSnapshot
  -> session workspace descriptor githubRuntime.pullRequest
  -> app useSidebarWorkspacesList()
  -> SidebarWorkspaceEntry.prHint
  -> Sidebar row badge + hover card checks
```

The remaining `checkout_pr_status_request` path is still present for explicit PR surfaces and compatibility, but the sidebar row badge no longer calls `useWorkspacePrHint()` and therefore no longer generates ad hoc checkout PR status requests per visible row.

## Shared Git Facts

`getCheckoutSnapshotFacts()` is now the first git read in the workspace snapshot builder. It gathers facts that were previously rediscovered by separate functions:

- worktree root: `rev-parse --show-toplevel`
- current branch: `rev-parse --abbrev-ref HEAD`
- origin remote URL
- Paseo worktree ownership and stored base ref
- resolved base ref and best comparison base
- main repo root
- branch remote/merge config
- tracked origin branch
- pull request lookup target for fork/PR worktrees

Those facts are then passed through `CheckoutContext` so status, shortstat, and PR status reuse the same answers instead of independently re-reading them.

## Current Data Flow

```text
Workspace subscription / fetch_workspaces
  -> session workspace registry
  -> workspaceGitService.getSnapshot(cwd, includeGitHub)
     -> refresh queue/throttle/dedupe per normalized cwd
     -> refreshGitSnapshot()
        -> getCheckoutSnapshotFacts()
        -> getCheckoutStatus({ facts })
        -> getCheckoutShortstat({ facts })
     -> refreshGitHubSnapshot()
        -> getPullRequestStatus({ facts })
     -> cached WorkspaceGitRuntimeSnapshot
  -> WorkspaceDescriptorPayload.gitRuntime
  -> WorkspaceDescriptorPayload.githubRuntime
  -> app session store
  -> useSidebarWorkspacesList()
     -> diffStat from descriptor
     -> prHint from descriptor.githubRuntime.pullRequest
```

## Startup Benchmark

Added deterministic real-home benchmark:

`packages/server/scripts/benchmark-startup-git-real-home.ts`

The script freezes the current Paseo home using the same metadata-copy shape as `scripts/dev-home.sh`: JSON under `agents`, JSON under `projects`, and `config.json`. It then starts an isolated in-process daemon against that frozen home, subscribes to workspaces/agents, records git invocations through `runGitCommand`, and reports elapsed time, git count, max concurrency, CPU, and memory deltas.

The frozen home used for the comparison contained 22 workspaces.

### Before/After

| run         | code shape                 | client shape                              | git commands | failures | elapsed |
| ----------- | -------------------------- | ----------------------------------------- | -----------: | -------: | ------: |
| baseline    | before change              | legacy sidebar PR fanout                  |          529 |       20 | 39039ms |
| split check | after change               | legacy sidebar PR fanout                  |          375 |       15 | 39039ms |
| after       | after change               | snapshot-only sidebar, no PR badge fanout |          372 |       15 | 31273ms |
| after 2     | after service fact sharing | snapshot-only sidebar, no PR badge fanout |          308 |       15 | 31334ms |

The server-side fact reuse accounts for nearly all measured git command reduction: `529 -> 375` (`-154`, `-29.1%`) even when the old PR fanout is still forced. Removing the sidebar fanout removes the ad hoc request path, but in this run it only changed command count by `3` because the refreshed workspace snapshots already carried the PR data by the time the fanout ran.

The second pass shares checkout facts between workspace observation setup and snapshot refresh. That removes another `64` git commands from the same frozen-home run: `372 -> 308` (`-17.2%` from the previous after, `-41.8%` from baseline).

### Baseline: before change + legacy PR fanout

```json
{
  "scenario": "legacyPrFanout",
  "workspaceCount": 22,
  "elapsedMs": 39039,
  "git": {
    "total": 529,
    "failed": 20,
    "maxConcurrent": 8,
    "byCommand": [
      { "key": "show-ref --verify --quiet refs/heads/main", "count": 66 },
      { "key": "rev-parse --git-common-dir", "count": 58 },
      { "key": "rev-parse --abbrev-ref HEAD", "count": 50 },
      { "key": "rev-parse --git-dir", "count": 36 },
      { "key": "show-ref --verify --quiet refs/remotes/origin/main", "count": 35 },
      { "key": "symbolic-ref --quiet refs/remotes/origin/HEAD", "count": 35 },
      { "key": "config --get remote.origin.url", "count": 32 },
      { "key": "ls-files --others --exclude-standard", "count": 18 },
      { "key": "rev-parse --absolute-git-dir", "count": 18 },
      { "key": "merge-base HEAD origin/main", "count": 17 },
      { "key": "rev-parse --show-toplevel", "count": 14 },
      { "key": "status --porcelain", "count": 14 }
    ]
  },
  "process": {
    "cpuUserMs": 2009,
    "cpuSystemMs": 2428,
    "rssDeltaMb": -1.5,
    "heapUsedDeltaMb": 16.9
  }
}
```

### After: after change + snapshot-only sidebar

```json
{
  "scenario": "snapshotOnly",
  "workspaceCount": 22,
  "elapsedMs": 31273,
  "git": {
    "total": 372,
    "failed": 15,
    "maxConcurrent": 8,
    "byCommand": [
      { "key": "config --get remote.origin.url", "count": 35 },
      { "key": "show-ref --verify --quiet refs/heads/main", "count": 34 },
      { "key": "rev-parse --git-common-dir", "count": 31 },
      { "key": "show-ref --verify --quiet refs/remotes/origin/main", "count": 22 },
      { "key": "status --porcelain", "count": 22 },
      { "key": "ls-files --others --exclude-standard", "count": 18 },
      { "key": "rev-parse --absolute-git-dir", "count": 18 },
      { "key": "merge-base HEAD origin/main", "count": 17 },
      { "key": "rev-parse --abbrev-ref HEAD", "count": 17 },
      { "key": "rev-parse --show-toplevel", "count": 17 },
      { "key": "symbolic-ref --quiet refs/remotes/origin/HEAD", "count": 17 },
      { "key": "rev-list --count main..origin/main", "count": 7 }
    ]
  },
  "process": {
    "cpuUserMs": 1871,
    "cpuSystemMs": 2152,
    "rssDeltaMb": 4.4,
    "heapUsedDeltaMb": 8.8
  }
}
```

### After 2: shared service-level facts

```json
{
  "scenario": "snapshotOnly",
  "workspaceCount": 22,
  "elapsedMs": 31334,
  "git": {
    "total": 308,
    "failed": 15,
    "maxConcurrent": 8,
    "byCommand": [
      { "key": "show-ref --verify --quiet refs/heads/main", "count": 31 },
      { "key": "rev-parse --git-common-dir", "count": 26 },
      { "key": "show-ref --verify --quiet refs/remotes/origin/main", "count": 22 },
      { "key": "ls-files --others --exclude-standard", "count": 18 },
      { "key": "status --porcelain", "count": 18 },
      { "key": "merge-base HEAD origin/main", "count": 17 },
      { "key": "config --get remote.origin.url", "count": 13 },
      { "key": "rev-parse --abbrev-ref HEAD", "count": 13 },
      { "key": "rev-parse --absolute-git-dir", "count": 13 },
      { "key": "rev-parse --show-toplevel", "count": 13 },
      { "key": "symbolic-ref --quiet refs/remotes/origin/HEAD", "count": 13 },
      { "key": "fetch origin --prune", "count": 5 }
    ]
  },
  "process": {
    "cpuUserMs": 1817,
    "cpuSystemMs": 1869,
    "rssDeltaMb": 16.7,
    "heapUsedDeltaMb": 10.4
  }
}
```

## Snapshot Equivalence Guard

Added a focused utility test proving that status, shortstat, and PR status return the same data when run from shared snapshot facts. The same test records git calls and asserts the facts-backed path does not re-run:

- `rev-parse --show-toplevel`
- `rev-parse --abbrev-ref HEAD`

Test:

`packages/server/src/utils/checkout-git.test.ts` -> `reuses checkout snapshot facts across status, shortstat, and PR status reads`

## Remaining Waste Visible In Baseline

This pass reshaped the data flow and removed the sidebar PR badge special path. It did not try to optimize every command.

The benchmark still shows repeated per-workspace reads that are candidates for the next pass:

- base ref existence checks still repeat as `show-ref` probes.
- default branch resolution still repeats `symbolic-ref refs/remotes/origin/HEAD`.
- repo common-dir lookup is lower, but still above the apparent git workspace count.
- shortstat still runs its own merge-base/diff/untracked scan per workspace.

The important invariant now is clearer: sidebar-visible git data should flow from `WorkspaceGitService` snapshots, and snapshot builders should receive reusable git facts through `CheckoutContext`.
