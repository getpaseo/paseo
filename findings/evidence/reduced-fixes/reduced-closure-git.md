# Fresh Git/scripts verification — reduced fixes

Candidate: shared uncommitted Git/scripts patch over 23cb8e83c, inspected 2026-09-22. Read-only verifier did not implement these files or rerun green tests. Inspected /tmp/reduced-git-result.md, actual production/test diffs and raw red/green logs listed below. Root owns finding status.

## FP3 / CR1-5 and L4 — read-only Git and cache accounting

Verdict: PASS for read invocation behavior and concurrent immutable-cache accounting.

All five Git invocation sites in change-stats/read.ts pass GIT_OPTIONAL_LOCKS=0 and LC_ALL=C, including content show, per-file patch, comparison numstat/full patch and untracked list. Numstat now matches patch's no-ext-diff/no-textconv behavior. Read-only options pass through the existing injected/default runGitCommand boundary. Category semantics, file limits, ref caching policy and concurrency stay unchanged.

Cache insertion subtracts the existing value for that key immediately before overwrite/add, with no await between subtraction/set/add/eviction. Concurrent completions therefore count actual retained entries instead of every completed read. The existing per-file size bound ensures one entry cannot exceed the total cache budget. No inflight registry or new cache policy added.

Inspected real Git tests with injected command recorder and coordinated concurrent results. Raw evidence: /tmp/git-read-red.log fails missing overlay, /tmp/git-read-green.log 5/5; /tmp/git-cache-red.log reproduces invalid eviction after concurrent overcount with subtraction withheld. Fixer restored exactly the already-green content afterward. This proves opt-out settings and cache correctness, not real-world index-lock collision frequency or performance. Production +10/-2.

## FP7 / CR1-10 — selected worktree owns its base ref

Verdict: PASS for real session-to-Git/metadata behavior, including custom roots.

CheckoutSession now passes its existing paseoHome/worktreesRoot/logger and expands cwd consistently. Inspected setCheckoutBaseRef: reads facts using provided context, validates existing/noncurrent ref, writes owned worktree metadata or ordinary-repo Git config. Removed path-string fast rejection no longer overrides actual configured-root ownership. Existing isPaseoOwnedWorktreeCwd remains authoritative: realpath-aware relative path under configured root/hash/slug; sibling status/base readers reuse the same helper and can now recognize roots named checkouts.

Raw /tmp/base-scope-red.log shows metadata stayed main, /tmp/base-scope-green.log 43/43. Tests call real session handler, real worktree creation, actual shared Git config and metadata: both worktrees and checkouts custom roots update selected base to develop, sibling/shared stay main, status resolves develop; ordinary checkout still updates repository config. Existing unsafe/ref failure checks remain. No end-to-end browser base-picker proof from this batch. Maintenance: passes existing context and removes duplicated ownership heuristic, no new context representation; some no-facts callers now perform existing ownership resolution rather than lexical rejection.

## FP8 / CR1-7 — invalid manifest preserves healthy Run entries

Verdict: PASS at discovery, list and launch boundaries; real browser presentation pending root's UI run.

Discovery catches malformed JSON/Zod validation and known missing/unreadable manifest errors per file, then continues descendants/siblings using lockfile/inherited package manager. Nested unreadable directories skip their subtree while an unavailable root still throws. Unexpected errors still propagate. Existing service list supplies logger, discovers fresh each request and builds snapshot including configured paseo.json scripts. Launch resolver separately rediscovers package scripts, so surviving nested scripts run even with malformed root, while removed selected scripts fail before terminal creation. No cached invalid-manifest state or diagnostics controller added.

Inspected raw /tmp/scripts-red.log, /tmp/scripts-green.log 6/6, /tmp/git-scripts-final-tests.log 34/34 (18 bootstrap +16 service). Real-fs tests cover invalid JSON and schema, inherited manager, descendant/sibling survival, configured-script preservation, repaired-root rediscovery and stale selected-script rejection. Modified Playwright expectation asserts healthy root menu then repaired manifest but was not yet run by this author. ENOENT/EACCES/EPERM race branches were inspected, not individually forced. Production +30/-5 discovery, +4/-1 list caller, small launch logger plumbing. Costs are local filesystem error ownership and optional existing logger.

## FP10 / CR1-21 — shell exit before bootstrap readiness

Verdict: PASS for stopped-terminal race and neighboring startup behavior.

After readiness, spawnWorkspaceScript reuses the same terminal identity/running predicate as the exit handler before completion-listener registration, working state or command send. If shell already stopped, rollback flag is cleared before throwing so recorded stopped exitCode survives. Existing listener/route cleanup stays in catch; ordinary exit and command completion share unchanged stop behavior. No new lifecycle state or terminal API.

Raw /tmp/bootstrap-guard-red.log: launch incorrectly resolves with guard withheld. /tmp/bootstrap-final-green.log 18/18 after final predicate extraction. New typed terminal adapter exits during pending bootstrap then emits readiness output, for both script/service variants; assertions cover rejection, stopped code7 retained, zero input/activity/completion subscriptions and no service route. Existing healthy startup, retained-terminal rerun and command completion are in same passing file. Sandboxed fixture failures were environment port/shell restrictions and isolated elevated run passed; no production daemon restarted. This is deterministic adapter evidence, not real shell-process timing or a concurrent replacement-start race.

## Overall evidence and cost

Inspected final /tmp/git-scripts-lint.log: 0 warnings/errors, and server typecheck log plus fixer exit0 report. No new tests executed by verifier. Production batch +69/-20; tests +295/-16. No protocol changes, worker/batch reader, Windows dialect redesign or ownership abstraction. Current corrections match accepted minimal-maintenance scope. Browser Run-menu proof remains explicitly separate; Windows unchanged and untested.

## Browser presentation addendum — FP8 final proof

Added by fresh UI verifier after inspecting root-run logs and actual ScriptGroup/test path; no tests rerun by verifier.

`/tmp/reduced-browser-final.log` initially failed only at the newly added `workspace-scripts-group-package.json` selector: after malformed nested manifest is skipped, root is the sole package and `ScriptGroup` renders a plain label rather than collapsible group trigger. Root removed that false trigger expectation/click, retaining direct healthy root-script visibility, no Retry error, and repaired nested manifest rediscovery. Production code unchanged.

Final `npm run test:e2e --workspace=@getpaseo/app -- --config reduced-playwright.config.ts workspace-package-scripts.spec.ts -g 'nested package scripts run'` PASS (one case, 4.5s / 12.4s total), raw `/tmp/reduced-scripts-browser-final.log`. Real Metro, browser, isolated daemon and npm terminal run. Test proves nested script starts, appears running, completes with exit0, malformed nested manifest leaves healthy root script visible without whole-menu error, repairing manifest makes nested script visible again on reopening. Test SHA256 b4d5e374e8a9fbe8458950737a58a2bebb836768e6149acb1c7bf0732678de48. Temporary browser config selects installed Chromium revision1234 rather than unavailable default1208; no transport mocks added. FP8 browser-presentation gap is now satisfied for this workflow. Other previously recorded Windows and filesystem-race limits remain.
