# Reduced Git/scripts implementation

Implemented FP3 + L4, FP7, FP8, FP10. No commits or findings-ledger edits. Product changes are local corrections; no batch reader, worker, Windows command dialect, cache lifecycle, or context architecture was added.

## Changes

- `packages/server/src/git/change-stats/read.ts`: all existing Git read invocations now opt out of optional locks and fix locale. Numstat opts out of external diff/text conversion like patch reads. Cache overwrite subtracts any prior entry before adding the completed immutable read, fixing concurrent miss overcount/eviction crashes.
- `packages/server/src/server/session/checkout/checkout-session.ts`: base setter receives existing paseoHome/worktreesRoot/logger; cwd expands `~` consistently.
- `packages/server/src/utils/checkout-git.ts`: remove literal `/worktrees/` ownership rejection. Configured-root resolver already owns this decision.
- `packages/server/src/server/workspace-scripts/package-scripts.ts`: malformed JSON, schema-invalid and transiently unreadable manifests are skipped per manifest. Healthy children continue using inherited/lockfile package manager. Transiently unreadable nested directories skip their subtree; root unavailability still throws. Existing service/bootstrap callers supply optional logger for diagnostic warnings.
- `packages/server/src/server/worktree-bootstrap.ts`: reuse one local runtime-identity/running predicate for exit and pre-send checks. After bootstrap wait, a stopped/replaced runtime rejects launch before adding completion listener, setting working, or sending command. Existing rollback flag is cleared so stopped exitCode survives. Routes still cleaned idempotently.
- `packages/app/e2e/browser/workspace-package-scripts.spec.ts`: old malformed-manifest whole-menu Retry expectation replaced by healthy-root script visibility and repaired-manifest rediscovery. Browser execution left to root orchestration.

## Test evidence

From `packages/server` unless specified:

1. `npx vitest run src/git/change-stats/read.test.ts --bail=1`
   - Red `/tmp/git-read-red.log`: expected read-only env overlay, got undefined.
   - Green `/tmp/git-read-green.log`: 5/5. Real Git and filesystem; comparison, file-patch and commit content paths preserve category results.
2. `npx vitest run src/git/change-stats/read.test.ts -t 'does not overcount' --bail=1`
   - With only cache subtraction withheld, red `/tmp/git-cache-red.log`: TypeError reading `.length` after overcount evicts last entry. 16 concurrent real immutable reads, barrier after Git results; aggregate falsely crosses 8MiB.
   - Restored subtraction matches prior 5/5 green candidate (formatting aside). No in-flight dedupe added; current behavior preserved.
3. `npx vitest run src/server/workspace-scripts/package-scripts.test.ts --bail=1`
   - Red `/tmp/scripts-red.log`: malformed JSON aborted healthy descendants/siblings.
   - Green `/tmp/scripts-green.log`: 6/6. JSON and schema failure, recovery, manager inheritance, unavailable-root error, existing exclusions/discovery.
4. `npx vitest run src/server/session/checkout/checkout-session.test.ts --bail=1`
   - Red `/tmp/base-scope-red.log`: selected metadata remained main after session reports develop.
   - Green `/tmp/base-scope-green.log`: 43/43. Real Git worktrees under custom `worktrees` and `checkouts`; session handler changes only selected worktree metadata, status resolves develop, sibling and shared config stay main; ordinary checkout still changes repo config. Existing unsafe-ref and failure tests pass.
5. `npx vitest run src/server/worktree-bootstrap.test.ts -t 'preserves stopped' --bail=1`
   - Guard withheld: red `/tmp/bootstrap-guard-red.log`: launch incorrectly resolves after shell exit.
   - Sandboxed full runs failed on existing shell fixture; service variant showed explicit `listen EPERM 127.0.0.1`. Authorized elevated targeted run then passed, proving environment restriction rather than implementation regression.
6. `npx vitest run src/server/worktree-bootstrap.test.ts src/server/session/workspace-scripts/workspace-scripts-service.test.ts --bail=1 --maxWorkers=1` (elevated for isolated test ports/shells)
   - Green `/tmp/git-scripts-final-tests.log`: 34/34 (18 + 16).
   - New deterministic terminal adapter exits during pending readiness, then signals output. Both script/service variants reject; stopped code 7 survives; no command input, activity or completion listener; no route remains.
   - Existing nested-package launch test now runs under malformed root manifest; removed selected script rejects without creating another terminal.
   - New service-list real-fs test keeps configured paseo.json script plus healthy nested package and discovers repaired root on next request.
7. After extracting shared local runtime predicate to meet existing complexity cap: `npx vitest run src/server/worktree-bootstrap.test.ts --bail=1` elevated: 18/18 `/tmp/bootstrap-final-green.log`. Healthy startup and retained-terminal reuse covered by existing tests.

Root scripts run:

- `npm run format:files -- <12 owned files>` success.
- `npm run lint -- <12 owned files>` success, 0 warnings/errors, `/tmp/git-scripts-lint.log`.
- `npm run typecheck --workspace=@getpaseo/server` success, `/tmp/git-scripts-typecheck.log` (process 6943 exit 0).

## Actual size

Production: +69/-20 across six files (89 changed lines).
Tests: +295/-16 across six files (311 changed lines), including Playwright expectation repair. Within parent budget.

Per-file numstat:

```
11 4 packages/app/e2e/browser/workspace-package-scripts.spec.ts
69 2 packages/server/src/git/change-stats/read.test.ts
10 2 packages/server/src/git/change-stats/read.ts
89 2 packages/server/src/server/session/checkout/checkout-session.test.ts
7 2 packages/server/src/server/session/checkout/checkout-session.ts
31 1 packages/server/src/server/session/workspace-scripts/workspace-scripts-service.test.ts
4 1 packages/server/src/server/session/workspace-scripts/workspace-scripts-service.ts
30 3 packages/server/src/server/workspace-scripts/package-scripts.test.ts
30 5 packages/server/src/server/workspace-scripts/package-scripts.ts
65 4 packages/server/src/server/worktree-bootstrap.test.ts
18 5 packages/server/src/server/worktree-bootstrap.ts
0 5 packages/server/src/utils/checkout-git.ts
```

## Limits and ownership

Pending fresh closure verification by another agent. Browser spec not run here. No Windows host tested. Filesystem ENOENT/permission branches inspected but no deterministic disappearing-directory or permission fixture executed. Warnings log on discovery request; no diagnostic storage/state added. Removing the hardcoded ownership reject means some paths without cached checkout facts now reach the existing resolver; correctness requires configured-root classification. Parent owns actual stats performance investigation. No performance claim or indexing collision-frequency claim made.
