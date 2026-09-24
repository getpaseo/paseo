# Fix plan for `introduce-pr-diff-chapters`

This ledger owns current finding status. [CR1](CR1.md) remains the historical review snapshot.

## ROUND-3 — Integrate the latest paseo-customizations

Authorized on 2026-09-24: commit and push the reduced fixes, merge latest paseo-customizations,
resolve conflicts, and check readiness. Fixes committed and pushed as `ff66c741b`.
Incoming parent: `160430f9452ab32c7b75b35d1ee5158d1f953c89`. No final merge into the target branch.
Merge committed and pushed as `d7c07411e`. Local merge validation passed 69 focused cases,
the server dependency build, typecheck, lint, and formatting. GitHub reports PR #2 mergeable.

CI run [35973248754](https://github.com/infi-pc/paseo/actions/runs/35973248754) found an outdated
client test expectation for the already-defaulted `preventSleepWhileAgentsRun: true` field.
Updated both exact config response expectations; no product behavior changed. The targeted client
file passes 17 cases. The correction is pushed as `fb4f42001`. Current readiness is **blocked by inherited CI failures**:
47 stale-fixture cases and 7 Hub authorization/MCP serialization cases in the Linux server job.
See [CR2 CI follow-up](CR2.md#ci-follow-up--current-readiness-is-blocked) for affirmative triage,
remaining actions, passing jobs, and pending platform/browser coverage. These blockers are open;
no risk acceptance or broader repair round is implied by the conflict-resolution authorization.

[CR2](CR2.md) records the focused integration review. CR2-1 / reviewer M-SERVER-1 is
**verified-closed** on the merge candidate: chapter fingerprints exclude live-file language
eligibility metadata. The real-service reproduction failed before the fix, passes after it,
and still detects actual hunk changes. Independent review confirmed one fingerprint owner and
unchanged language safety checks. The correction is two product lines plus focused regression cases.

All earlier reduced fixes are retained. Sleep runtime/tests now use the incoming implementation,
which subsumes the approved config subscription fix and adds backend-state handling. Previously
deferred items stay deferred; this integration does not expand their scope. Candidate hash and
verification evidence are in `findings/evidence/merge-paseo-customizations/`.

## ROUND-2 — Implement the reduced personal-fork scope

**Current authorization:** Michael requested only fixes that affect his usage or future maintenance,
approved the reduced scope and LOC estimate, then said “ok, implement.” This overrides ROUND-1's
unselected defaults, including its broad bare-go interpretation. ROUND-1 below is historical.
No commit, push, production-daemon restart, or broader redesign is part of this round.

**Candidate:** working-tree patch on `23cb8e83c1a899b631d8b08a896992a5da0f7faa`.
**Base:** unchanged `fdf3b4b47f1aae0f4f44e8c97210f8b907159edb`.
**Method:** three bounded fixers and independent cross-verifiers; the orchestrator owns UI edits,
measurements, integration checks, and this record. Fresh verification found a split-retry fatal
cleanup gap and native summary-mask/truncation issues; each received a bounded correction and recheck.

### Current dispositions

| Finding / plan   | Reduced action                                                              | Current result                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| CR1-1 / FP1      | Persist both background tab variants                                        | Fixed; real persistence/recreation preserves multiple workspace layouts.                                                       |
| CR1-3 / FP4      | Skip helper runtimes without supported restrictions                         | Fixed at provider creation boundary; existing eligible selection order preserved.                                              |
| CR1-4 / FP5      | Put summary content inside the shared badge controls and loading renderer   | Fixed; real app browser proves running shimmer, file action, and completed state. Existing summary design retained.            |
| CR1-5 + L4 / FP3 | Read-only Git options and correct concurrent cache overwrite accounting     | Fixed; real Git and concurrent-read regressions pass.                                                                          |
| CR1-10 / FP7     | Pass configured worktree ownership context; remove hardcoded path rejection | Fixed; selected custom-root worktree changes without changing sibling/shared base.                                             |
| CR1-7 / FP8      | Skip invalid manifests individually                                         | Fixed server behavior; healthy root/children/siblings and configured scripts survive. Browser Run-menu/repair scenario passes. |
| CR1-6 / FP11     | React to sleep setting changes during a run                                 | Fixed; subscribe through existing config owner and unsubscribe on dispose.                                                     |
| CR1-11 / FP13    | Ignore unresolved workspace observations in history                         | Fixed after red reproduction; real history/layout/replay path retains Forward entries.                                         |
| CR1-21 / FP10    | Check terminal runtime after bootstrap readiness                            | Fixed; stopped/replaced terminal cannot receive launch input or become working.                                                |
| CR1-22 / FP12    | Hide sleep control until config is loaded                                   | Fixed; source boundary checked independently.                                                                                  |
| CR1-13 / FP16a   | Fetch recently closed agents when its menu opens                            | Partial parent resolution: lazy query implemented; hidden activity-feed work deferred.                                         |
| CR1-12 / FP17    | Finish abandoned summary queue requests                                     | Partial parent resolution: drop/overflow/split/fatal paths fixed; chapter retention deferred.                                  |
| CR1-8 / FP14     | Require actual project identity in workspace header helper                  | Fixed; real app sidebar navigation verifies project identity.                                                                  |
| CR1-2 / FP2      | Measure actual comparison path before optimizing                            | Investigation complete; optimization deferred on measured warm-save behavior.                                                  |

Every remaining ROUND-1 plan or plan remainder is **deferred outside the approved scope**, not
implicitly accepted as harmless. This includes permissions expansion, summary-toggle lifecycle,
chapter cache retention, hidden-feed ownership, Windows command dialects, shutdown redesign,
missing-base policy, protocol identity/naming, broad test migrations, and documentation/i18n cleanup.
Revisit a deferred item when it breaks Michael's workflow, a supported environment changes, or
measurements demonstrate a recurring cost. No new controller, provider runner, Git batching layer,
background worker, retention service, or wire schema was added.

### Performance evidence

The direct stats function used by workspace refresh was measured against this checkout's actual
configured comparison base, `refs/remotes/origin/paseo-customizations`, with the fixes in progress.
The script changes one temporary source file between forced refreshes and removes it afterward.

| Pass        | Total elapsed | Git commands / git show | Maximum event-loop delay |
| ----------- | ------------- | ----------------------- | ------------------------ |
| Cold        | 1,470 ms      | 79 / 73                 | 87 ms                    |
| Warm save 1 | 331 ms        | 18 / 12                 | 7 ms                     |
| Warm save 2 | 328 ms        | 18 / 12                 | 7 ms                     |
| Warm save 3 | 344 ms        | 18 / 12                 | 6 ms                     |

Each result retained categorized statistics (5,043 additions, 195 deletions). This narrows CR1's
claim that every save necessarily repeats full-branch fan-out. It does not prove complete daemon,
terminal, or agent-stream latency under concurrent load, and the cold delay remains measurable.
No structural optimization is warranted by this sample within the approved scope.

### Verification and limits

Baseline typecheck/lint were rerun before edits and passed. Focused regression files pass:
layout persistence 3; history recording 3 and existing recorder 8; summary integration 12;
summary service 13; sleep inhibitor 12; Git reads 5; manifest discovery 6; checkout session 43;
script service 16; bootstrap 18. Total: **139 focused cases**. Green files were not rerun by
verifiers; independent verification inspected test evidence, implementation, and adjacent paths.
All three focused browser scenarios also pass: project/header identity, running/completed summary controls, and Run-menu execution plus malformed-manifest recovery. Final whole-workspace typecheck and lint pass. Total: **142 focused cases**, including 3 browser cases. Targeted formatting check and `git diff --check` pass.

Test evidence uses real files/Git/stores/manager boundaries and existing deterministic provider
and terminal adapters. It does not verify live provider sandbox enforcement, physical OS sleep,
or native shimmer rendering. History is proven through real replay logic; actual Electron React
timing is unverified. Browser runs use the existing real app/isolated-daemon harness and installed
Chromium headless shell 1234; the runner's expected 1208 download stalled and was stopped.
No main daemon was restarted. Initial sandbox port/shell failures were resolved with authorized
isolated test execution. The abandoned leaf-browser attempt could not parse a transitive native
Flow dependency; no framework or module-stub refactor was added to work around it.

Evidence and fresh verifier reports: [round evidence](evidence/reduced-fixes/).

### Final patch size and execution notes

Product code: **+288 / −106 lines**, net +182 across 15 files (394 added/deleted lines).
Tests and existing mock-provider fixture: **+835 / −36 lines**, net +799 across 15 files.
This includes two new regression files. Evidence/ledger documents are excluded. The product diff
is modestly above the 155–335 LOC estimate because the existing native and web shimmer paths both
need to render and measure the same compact summary content; 106 deleted lines include moved
rendering/recording code. No new dependency or separate lifecycle owner was added.

Browser command: `npm run test:e2e --workspace=@getpaseo/app -- --config <temporary-config> <spec> -g <case>`.
The temporary config inherited the repository config, selected installed Chromium shell 1234,
and disabled trace/video after the initial run stalled finalizing its failed trace. It has been
removed. Selected cases: `new-workspace.spec.ts` / sidebar workspace navigation; `tool-call-shimmer.spec.ts`
/ a summary label keeps; `workspace-package-scripts.spec.ts` / nested package scripts run.
The initial new badge test used an incorrect agent-tab test ID, corrected to the existing `agent_`
convention. The initial updated script test expected a collapsible group even when only one
package remained; corrected to assert the script row directly, matching existing menu behavior.
Neither failure required a product change. Successful scenarios were not rerun afterward.

Final logs are preserved under the evidence directory. Full suites were not run. Delayed sleep
config rendering and lazy history fetch have independent source/consumer-boundary verification,
not dedicated browser timing/network-count tests. Native rendering and actual Electron navigation
timing remain runtime verification limits. No claim that excluded parent-finding concerns were fixed.

## ROUND-1 — Plan fixes without changing the product

**Requested phase:** plan-only, from `/infi-fix-planning` after CR1. No implementation,
commit, push, or accepted residual risk is authorized by this planning invocation.

**Candidate:** `23cb8e83c1a899b631d8b08a896992a5da0f7faa`.
**Base:** `fdf3b4b47f1aae0f4f44e8c97210f8b907159edb`, unchanged merge-base with `origin/main`.
GitHub lookup found no pull request for `infi-pc:introduce-pr-diff-chapters`.
The product/test tree is clean and matches CR1. The only pre-existing untracked file was
`findings/CR1.md`, SHA-256 `141694840a0dfcf030984bf9fe98e97f2b2946aeac074b5b12678b8000ebf5c1`
before adding the status-owner pointer. Records alone do not change the reviewed candidate.

**Capacity:** four total agents: orchestrator and three read-only planners, as directed by
the fix-planning skill. No fixers or closure verifiers were dispatched.

**Supported guarantees:** opening tabs preserves saved layouts; ordinary saves preserve
interactive daemon responsiveness and categorized statistics; helper work respects its
provider authority and configured selection; permissions match the action and data;
workspace-local changes stay local; existing supported platforms retain behavior.
Optimize for this personal fork, preserve feature intent, and maintain English only.
No recurrence or prior fix ledger exists for this candidate.

**Evidence limits:** plans are based on source inspection, not new reproductions or benchmarks.
CR1 reports green typecheck, lint, formatting, and 42 locale-resource tests on this exact
product candidate. Those results are inherited evidence, not checks executed in this round.
All proof below is proposed unless explicitly identified otherwise. No finding is closed.

## Decision sheet

Recommendations below preserve all current feature surfaces. No portfolio has been selected for
implementation, so estimates are per-plan ranges, not an additive delivery commitment. Shared
fixtures and overlapping edits must be counted once when a portfolio is selected. Historical
S/F → P ratings are retained in the status table; factual corrections narrow the claims rather
than silently rewriting CR1.

Start with FP1. Run FP2's real-path red reproduction before choosing its optimization; use FP3's
read-only Git boundary with it. Next prioritize helper restrictions (FP4), visible tool state
(FP5), operation authority (FP6), workspace ownership (FP7), and reliable scripts/settings/history.
Coverage plans run with the fixes they prove, not as a final cleanup stage. Documentation and
compatibility/copy hygiene follow the behavior decisions.

The pending summary-provider preference uses **preserve existing selection plus a live toggle**
as the recommended assumption (FP18). This does not constitute implementation authorization.
Other judgment choices are explicit in each plan: canonical command placement, activity access
policy, hidden feed freshness, cache retention, missing-base fallback versus explicit error,
shutdown semantics, and legacy RPC/native-copy conventions. A future bare “go” would select
these stated defaults, without authorizing commits, pushes, arbitrary risk acceptance, or
restarting the main daemon. An explicit contrary answer overrides the relevant default.

| Plan | Problem → default solution                                                                                                                                               | Maintenance change                                                                     | Decision / coverage                                                   | Size context                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| FP1  | Background tabs erase persisted layouts → represent both targets in storage                                                                                              | Complete existing schema ownership                                                     | Mechanical; CR1-1                                                     | +10–25/−0–5; tests +80–130                                                                  |
| FP2  | Large breakdown refreshes consume subprocess/CPU headroom → measure the real path, then batch reads, cache classifications and yield while retaining composer categories | One scheduled comparison reader; replace per-file process fan-out                      | Judgment; CR1-2 S1/F1 → P1                                            | Production +140–260/−40–80; tests +140–230/−0–20; touched 230–360 production, 150–250 tests |
| FP3  | Background Git reads can refresh the index → enforce read-only options inside the breakdown reader                                                                       | One local command boundary owns flags                                                  | Mechanical; CR1-5 S2/F2 → P2                                          | Production +10–25/−5–15; tests +30–60; touched 30–55 production, 30–60 tests                |
| FP4  | Helpers can run without restrictions → centrally resolve eligible runtime policy; verify chapters fallback/deadline                                                      | One policy owner, preserve distinct persistent-summary and one-shot-chapter lifecycles | Judgment on eligible providers; containment mechanical; CR1-3, CR1-33 | Production +60–110/−30–55; tests +180–280/−0–30                                             |
| FP5  | Generated labels lose loading/file controls → compose inside badge shell                                                                                                 | One shell owns controls for both label forms                                           | Judgment for canonical command placement; mechanical controls; CR1-4  | +45–85/−20–45; tests +100–160                                                               |
| FP6  | RPC authority mismatches effects → authorize chapter generation separately from reads; protect activity by workspace authority                                           | Message-sensitive decision owned by authorization module                               | Judgment on background admin restriction; CR1-9                       | Production +45–85/−10–20; tests +90–150                                                     |
| FP7  | Base changes can write outside the chosen worktree → pass configured ownership context and remove the hardcoded path heuristic                                           | Existing ownership resolver becomes authoritative                                      | Mechanical; CR1-10 S2/F2 → P2                                         | Production +10–30/−5–12; tests +70–120; touched 25–50 production, 70–120 tests              |
| FP8  | One invalid manifest hides unrelated runnable scripts → isolate discovery failures per directory/manifest                                                                | Discovery owns partial failure; callers receive healthy scripts                        | Mechanical; CR1-7 S2/F2 → P2                                          | Production +30–60/−5–15; tests +70–120; touched 45–80 production, 70–120 tests              |
| FP9  | Package scripts use the wrong Windows shell syntax → render commands for the terminal's actual shell                                                                     | Typed invocation + terminal dialect owner replaces platform guessing                   | Judgment; CR1-15 S2/F0 → P2                                           | Production +90–160/−15–35; tests +100–180; touched 140–220 production, 100–180 tests        |
| FP10 | A dead terminal receives post-bootstrap work → recheck the authoritative runtime before sending                                                                          | Existing lifecycle owns the guard                                                      | Mechanical; CR1-21 S2/F3 → P3                                         | Production +8–18/−0–4; tests +35–65; touched 15–30 production, 35–65 tests                  |
| FP11 | Sleep setting does not apply immediately → subscribe to config changes                                                                                                   | One existing subscription + disposal                                                   | Mechanical; CR1-6                                                     | Production +5–12/−1–3; tests +35–65/−0–8                                                    |
| FP12 | Sleep switch invents a value before load → omit until config exists                                                                                                      | Reuse config query readiness                                                           | Mechanical; CR1-22                                                    | +1–4/−1–2; tests +25–45                                                                     |
| FP13 | Back truncates Forward through tabless entries → skip non-resting samples                                                                                                | Recorder keeps replayable locations only                                               | Mechanical; CR1-11                                                    | +5–15/−0–5; tests +70–120/−10–20                                                            |
| FP14 | Header tests silently skip identity checks → assert intended wide/compact surfaces                                                                                       | Explicit helper variants, no presence-based opt-out                                    | Mechanical; CR1-8                                                     | +0–10/−0; tests +90–150/−35–65                                                              |
| FP15 | Base setting and activity paging lack behavioral proof → test real UI and extract feed lifecycle port                                                                    | One controller owns paging/subscription; base mutation owns operation state            | Mechanical base behavior; judgment feed extraction; CR1-17            | +140–220/−65–95; tests +220–360/−30–60                                                      |
| FP16 | Closed menus/hidden panels do work → gate query, feed, and clock by visibility                                                                                           | Reuse existing menu and retained-panel ownership                                       | Judgment for hidden feed policy; mechanical menu; CR1-13              | +20–40/−3–10; tests +60–100                                                                 |
| FP17 | Chapter history and dropped summary batches accumulate → bounded chapter retention and complete request ownership on drops                                               | One retention owner; one batch reconciliation owner                                    | Judgment on retention policy; CR1-12                                  | Production +130–220/−20–45; tests +150–250                                                  |
| FP18 | Summaries lack live control → add mutable config and toggle, serialize owner transitions                                                                                 | One live lifecycle owner; preserve existing routing/default pending user choice        | Judgment; CR1-14                                                      | Production +120–210/−15–35; tests +150–250; generated separately                            |
| FP19 | Deleted preferred base hides change stats → ignore an unavailable preference and use existing default resolution                                                         | Existence validation stays at preference resolution                                    | Judgment; CR1-16 S2/F2 → P2                                           | Production +10–25/−1–5; tests +45–80; touched 20–40 production, 45–80 tests                 |
| FP20 | Shutdown may await an ordinary quit prompt → distinguish OS shutdown from interactive quit and cancel pending prompt wait                                                | Main-process quit origin and deadline own lifecycle                                    | Judgment; CR1-20 S2/F2 → P2                                           | Production +55–100/−10–25; tests +90–150; touched 90–160 production, 90–150 tests           |
| FP21 | Fake script-menu tests duplicate/miss browser behavior → migrate distinct cases before deleting                                                                          | Remove branch-added mock dependency                                                    | Mechanical; CR1-18                                                    | 0; tests +35–65/−170–220                                                                    |
| FP22 | Activity identity requires contradictory fields → internal semantic identity with legacy wire projection                                                                 | Producers choose one identity, projection/labels centralized                           | Judgment; CR1-19                                                      | Production +45–80/−15–30; tests +35–65                                                      |
| FP23 | Protocol cleanup must retain existing clients → dated capability notes, stop unused advertisement, retain legacy names explicitly                                        | No unnecessary aliases unless rename is selected                                       | Judgment on naming exception; CR1-25                                  | Production +10–20/−1–3; tests 0–15; comments need inspection only                           |
| FP24 | Chapters interprets '~' as a literal directory → expand at session boundary                                                                                              | Matches checkout siblings                                                              | Mechanical; CR1-26                                                    | Production +2–4/−1; tests +15–30                                                            |
| FP25 | Pulse checks depend on wall clock → isolate deadline through timer/animation ports                                                                                       | Single deadline owner, real-browser rendering proof                                    | Judgment; CR1-23                                                      | +45–80/−20–35; tests +110–180/−80–115                                                       |
| FP26 | Screenshots escape test artifacts → use runner output locations                                                                                                          | Runner owns collision isolation and collection                                         | Mechanical; CR1-24                                                    | config +1–5; tests +5–12/−4–8                                                               |
| FP27 | Names, surface lists and index disagree → rewrite owning docs and minimal UI wording                                                                                     | One location per contract; no code identifier renames                                  | Mechanical documentation; judgment copy; CR1-27, CR1-28, CR1-29       | UI +1–3/−1–3; docs +35–60/−20–35                                                            |
| FP28 | PR navigation and change statistics lack rationale → document contracts beside owners                                                                                    | Explain cross-module rules, link code taxonomy                                         | Mechanical; CR1-30                                                    | 0; docs +35–65/−0–5                                                                         |
| FP29 | Native quit strings bypass resource ownership → use an English native resource dictionary                                                                                | Native dialog remains independent of renderer availability                             | Judgment; CR1-31 S3/F1 → P3                                           | Production +15–30/−5–10; docs +3–6; tests +0; touched 25–45 production                      |
| FP30 | Copy ownership and resource keys drift → separate handoff instruction and UI resources                                                                                   | Explicit label mapping, real i18next proof                                             | Mostly mechanical; stylistic rename optional; CR1-32                  | +10–25/−10–25; tests +15–35/−12–25                                                          |

## Corrections that affect the choices

- CR1-1 affects saved layouts in the current app installation, across its hosts/workspaces;
  it does not delete agents or other users' installations.
- CR1-2's watcher path passes a merge-base SHA and benefits from both content and classification
  caches. Large cold/churning workloads remain a concern. The asserted per-save process count
  and multi-second interactive stall were not reproduced. Preserve categorized composer stats.
- CR1-3 establishes unrestricted helper options for unsupported runtimes, not observed abuse.
  Known read-only runtimes are not all tool-free either; prove the exact promised authority.
- CR1-4's actual approval card still renders raw tool details. Repair timeline affordances;
  do not claim a demonstrated approval bypass or invent a pending-approval tool status.
- CR1-9's proposed permission array means OR. It cannot enforce a conjunction. Chapter requests
  with either generation flag must be treated as writes while cache-only reads can stay reads.
- CR1-14 has a config-file opt-out. The missing feature is discoverable live control; automatic
  use of a different configured vendor remains a policy choice.
- CR1-20's Windows mechanism is contradicted by installed Electron declarations: Windows system
  shutdown does not emit `before-quit`. Native shutdown behavior needs platform evidence.
- Do not implement the review's `--`-before-Git-refs hint, widen emitted literal values without
  old-client proof, or finish a shared background request when only one member is dropped.

## Current status and accountable plans

All IDs were imported as known-open from CR1 and are now **planned**, not fixed. No fixing
commit exists. Mixed findings have one parent owner and explicit proof sub-obligations; that
accountability grouping does not require combining unrelated code into a single commit.

| Finding | Historical risk         | Status  | Accountable plan | Fixing commit |
| ------- | ----------------------- | ------- | ---------------- | ------------- |
| CR1-1   | S1/F1 → P1              | planned | FP1              | —             |
| CR1-2   | S1/F1 → P1              | planned | FP2              | —             |
| CR1-3   | S2/F2 → P2              | planned | FP4              | —             |
| CR1-4   | S2/F1 → P2              | planned | FP5              | —             |
| CR1-5   | S2/F2 → P2              | planned | FP3              | —             |
| CR1-6   | S2/F1 → P2              | planned | FP11             | —             |
| CR1-7   | S2/F2 → P2              | planned | FP8              | —             |
| CR1-8   | S2/F0 → P2              | planned | FP14             | —             |
| CR1-9   | S2/F1 → P2              | planned | FP6              | —             |
| CR1-10  | S2/F2 → P2              | planned | FP7              | —             |
| CR1-11  | S2/F2 → P2              | planned | FP13             | —             |
| CR1-12  | S2/F2 → P2              | planned | FP17             | —             |
| CR1-13  | S2/F1 → P2              | planned | FP16             | —             |
| CR1-14  | S2/F0 → P2              | planned | FP18             | —             |
| CR1-15  | S2/F0 (on Windows) → P2 | planned | FP9              | —             |
| CR1-16  | S2/F2 → P2              | planned | FP19             | —             |
| CR1-17  | S2/F1 → P2              | planned | FP15             | —             |
| CR1-18  | S2/F2 → P2              | planned | FP21             | —             |
| CR1-19  | S2/F2 → P2              | planned | FP22             | —             |
| CR1-20  | S2/F2 → P2              | planned | FP20             | —             |
| CR1-21  | S2/F3 → P3              | planned | FP10             | —             |
| CR1-22  | S3/F2 → P3              | planned | FP12             | —             |
| CR1-23  | S2/F3 → P3              | planned | FP25             | —             |
| CR1-24  | S3/F1 → P3              | planned | FP26             | —             |
| CR1-25  | S3/F0 → P3              | planned | FP23             | —             |
| CR1-26  | S3/F3 → P3              | planned | FP24             | —             |
| CR1-27  | S3/F0 → P3              | planned | FP27             | —             |
| CR1-28  | S3/F0 → P3              | planned | FP27             | —             |
| CR1-29  | S3/F0 → P3              | planned | FP27             | —             |
| CR1-30  | S3/F0 → P3              | planned | FP28             | —             |
| CR1-31  | S3/F1 → P3              | planned | FP29             | —             |
| CR1-32  | S3/F3 → P3              | planned | FP30             | —             |
| CR1-33  | S3/F2 → P3              | planned | FP4              | —             |

## Detailed alternatives and proposed proof

## FP1 — Preserve layouts when Background activity is opened

**Covers:** CR1-1 (S1/F1 → P1). Reach recalibration: one occurrence removes this app installation's `workspace-layout-state`, spanning its workspaces/hosts; it does not erase server-side agents or every user's state.

**Default:** Add strict `background_activity` and `background_thread` variants with the exact model fields to `WorkspaceTabTargetStorageSchema`. Keep threads restorable: their panel already renders unavailable-session recovery when daemon retention expires. Producer `openTab`, identity normalization, `partialize`/ephemeral stripping, validated storage `setItem`, and rehydration `merge` were inspected. No migration or persistence-version change is required for adding currently missing variants.

**Alternative:** Persist activity but classify threads as ephemeral. It uses existing stripping ownership and costs production +5–12, tests +70–110, but removes thread restoration without evidence this is intended. Generic per-tab salvage or changing all validated stores' error semantics expands the contract unnecessarily.

**Proof proposed:** P1 red then green through `createWorkspaceLayoutStore` public actions → actual validated storage → second store rehydrate. Persist two workspaces, splits/focus/Explorer and both new targets, flush writes, assert the complete meaningful restored state; repeat with thread optional `requestId` absent. Use typed storage injection (small factory dependency, default AsyncStorage) instead of extending existing `vi.mock`. Add real browser open/reload smoke. Include existing ephemeral tabs remaining absent. Default touched production 15–35, tests 80–130. Execute before other UI work.

## FP2 — Keep live categorized statistics without branch-size subprocess fan-out

**Covers CR1-2 (S1/F1 → P1). Default:** preserve breakdowns on every existing consumer, including `useVisibleWorkspaceDiffStat` → `ComposerDiffStatPill`. First measure the real refresh; then resolve refs once, read immutable blobs in bounded Git batches under the existing scheduler, cache classifications by content with byte-accounted limits, and yield between file analyses. Keep existing snapshot publication semantics; do not publish stale breakdowns against new totals. Coalesce superseded requests without discarding the latest edit. This is a candidate correction pending measured response-budget proof, not permission to accept stalls.

**Evidence correction:** shortstat already passes a merge-base SHA, so its immutable cache works. The report's symbolic-ref observation belongs to `getCheckoutDiff`. `classifyDiff` skips parsing on cache hits; excluded categories and unsupported extensions further narrow cost. Cold loads and >256-entry churn remain credible, but “every save performs 2N parses” and seconds of terminal lag are unproven. Inspecting watcher debounce and worktree/ref refresh paths confirms expensive work shares daemon resources.

**Alternative:** keep batched reads but move cold parsing to one bounded worker owned by the comparison service (production +300–550/−50–110; tests +180–300/−0–30; touched 450–750 production, 200–330 tests). Default adds no worker startup, failure or packaging machinery, but one large parse can still block. The worker earns its cost if the default cannot meet measured responsiveness; do not declare closure on a merely reduced process count.

**Proof:** first reproduce through real `WorkspaceGitService` subscription on 300 changed source files, cold then repeated single-file saves. Capture command counts, snapshot latency, and an independent daemon request heartbeat. Red/green must demonstrate bounded command count and responsive daemon while composer categories reconcile and update. Exercise ref moves, concurrent misses, cache eviction (L4 accounting), rename/delete, untracked, truncation and teardown; the worker alternative additionally proves error visibility and packaged startup. Use current primitive/performance harness, plus targeted composer spec. Avoid simply dropping breakdowns. No timing budget was accepted yet; record measured baseline and propose the budget before calling performance fixed.

**Integration:** FP3 shares reader code; serialize. Batch input requires a scheduler-aware Git stdin port or existing equivalent, not unscheduled child processes. Validate unsafe refs at the read boundary (L2); inserting `--` before refs changes them into pathspecs and is not a fix. No wire changes planned. Production touched estimate includes the runner port; the alternative includes worker packaging/lifecycle. No generated output assumed.

## FP3 — Keep categorization reads from updating the Git index

**Covers CR1-5 (S2/F2 → P2). Default:** put a read-only command helper inside `git/change-stats` that always adds `GIT_OPTIONAL_LOCKS=0` and `LC_ALL=C`; route existing and FP2 batch commands through it, with `--no-ext-diff --no-textconv` on both diff forms. This boundary is complete for breakdown entry points and avoids asking every caller to remember an overlay.

**Inspected:** `readComparisonBreakdown`, `readFileBreakdown`, `addFileBreakdowns`; shortstat, full checkout diff, and commit-file consumers; `runGitCommand` and injected refresh wrappers. None currently supplies the missing default. This establishes omission, not an observed collision rate: `show` does not itself acquire an index write lock, so “all five reads fight for index.lock” is overstated.

**Alternative:** apply the overlay separately at each command (production +5–15, tests +30–60). Smaller change but every future batch/read call has a caller obligation; reuse an existing shared read-only environment constant if available without creating a broad command framework. Default touched LOC 30–55, alternative 10–25.

**Proof:** wrap the real Git runner to record submitted options for full comparison and per-file/commit paths, assert every invocation opts out of optional locks, and compare resulting categories. An index-stat refresh fixture can demonstrate index metadata stays unchanged; a race loop is supplemental, not required to prove policy. No deterministic collision claim.

**Decision:** mechanical. Land after FP2 reader shape settles, or integrate under one owner with separate proof. Do not globally set optional-lock policy on write commands.

## FP4 — Constrain helpers before starting them, and prove chapter failure paths

**Covers:** CR1-3 S2/F2 → P2; CR1-33 S3/F2 → P3.

**Default:** Add a runtime-policy resolver next to structured generation with explicit `summary` and `chapters` purposes; return unsupported for unrecognized runtimes. Summary input-only and chapters repository-read policies intentionally differ. Both callers record unavailable/unsupported candidates. Keep summary reuse/idle retirement/retry selection and chapters one-shot disposal distinct. Add chapter fallback, denial, deadline, and cleanup coverage rather than routing both through a new universal executor.

**Inspected:** summary `generation.ts` helper/run/close; chapter generate/runHelper/runWithDeadline; shared `agent-response-loop.ts` fallback; provider selection and local adapter option schemas. The unrestricted `undefined` branch is real. Read-only Codex still has read/shell tools; don't claim all existing known runtimes are tool-free. Confirm effective adapter options, MCP/tool injection, and sandbox behavior for the policy being promised. No credentials-based guarantee was established here.

**Alternative:** Extend the shared fallback runner and migrate both lifecycles. It removes duplicated loops but must absorb resident helpers, cancellation acknowledgment, schema retries, deadlines, observation, and source invalidation; disproportionate unless these can stay as explicit runner adapters.

**Size:** default production +60–110/−30–55, touched 120–220; tests +180–280/−0–30. Alternative production +180–300/−180–270; tests +260–420.

**Proof (proposed):** injected provider adapters through real manager test harness: unsupported source provider never starts; fallback picks eligible next candidate; no candidates reports visible failure; permission denied; deadline cancels then closes/deletes; refused cancellation does not start a second uncontrolled helper. Test chapter schema retries separately from provider fallback. Avoid tests that only assert the resolver's own table. If deadline/refusal behavior is newly defective, stop dependent implementation and revise contract.

**Decision/dependencies:** judgement because unsupported-runtime summaries become unavailable; known incapable runtimes must not be silently treated as trusted. Order before FP18; touches chapters generation and background recording also used by FP17/FP22. L5 is a linked observation/recovery question, not authorization to resume refused cancellations.

## FP5 — Keep tool execution visible while retaining generated descriptions

**Covers:** CR1-4 (S2/F1 → P2), with separate affordance and command-presentation obligations.

**Default:** Route both label forms through `ExpandableBadgeLabelRow`; the row owns loading rendering, measurements, and open-file action. Keep generated input/output text. Recommended judgment choice: show the canonical shell command as a subordinate, identifiable line while retaining the generated phrase. Preserve raw details and existing approval card. Inspect `message.tsx`, `summary-label.tsx`, `presentation.ts`, protocol display model and `PermissionRequestCard`.

**Recalibration:** The actual approval card renders `ToolCallDetailsContent` from `request.detail/input` before approval buttons. It does not consume summary metadata. Timeline statuses have no pending-approval value. The report proves misleading glanceable labels, not replacement of approval evidence or a demonstrated prompt-injection exploit. Do not implement a nonexistent pending-approval status gate.

**Alternative:** Restore controls while retaining the current generated-only collapsed label and authoritative expanded details. Production +25–45/−15–30, tests +70–110; smaller and preserves compact design, but leaves the product choice about glanceable command visibility unresolved. This option does not itself authorize accepting that concern.

**Proof proposed:** Deterministic hostile/misleading metadata fixture, actual presentation mapping, running→completed/failed transitions, file opening even when filename is absent from prose, raw permission command rendering; real-browser badge visual interaction plus native render smoke. No model-obedience test. Default touched production 100–160. Overlap protocol `tool-call-display.ts`, app `message.tsx`, English copy with other planners; serialize.

## FP6 — Check the authority for what each request actually does

**Covers:** CR1-9 S2/F1 → P2, with separate chapter-generation and background-content obligations.

**Default:** Keep cache-only chapter reads under `workspace.read`; have authorization inspect the full inbound message and require `workspace.write` when `generate || regenerate`. `regenerate` alone currently starts work. New app sends generate only with write authority and presents read-only cached/empty states; denied direct RPCs never reach generation. Classify activity snapshots, subscription requests/responses, and changed events consistently as workspace-content reads. Whether admin authority must also be required is an explicit decision.

**Inspected:** `SessionAuthorization`, both permission maps, session handlers/subscription callback, chapter service `get`, app `useChapters`. Arrays mean **OR** (`requirement.some`), so CR1's proposed `[workspace.read, daemon.manage]` does not enforce both. If retaining admin restriction is chosen, add a narrow explicit all-of requirement at the authorization owner, never globally reinterpret arrays.

**Alternative:** Require write for every chapter request and both permissions for activity. Smaller chapter code but removes read-only chapter viewing; all-of support adds a representation. It preserves admin-only access at extra policy cost.

**Size:** default production +45–85/−10–20, touched 90–160; tests +90–150. Alternative production +20–45/−5–12; tests +70–120.

**Proof (proposed):** real session transport with principals read-only, write-only, daemon-manage-only, combined: cached reads allowed; either generation flag denied to readers; permitted generation starts once; background content matches chosen policy including changed events after grant replacement. UI proof uses real browser/daemon for reader empty/cache states. Requires app/protocol integration owner.

## FP7 — Write a base branch only to its intended ownership scope

**Covers CR1-10 (S2/F2 → P2). Default:** pass `{paseoHome, worktreesRoot}` and logger from `CheckoutSession` into `setCheckoutBaseRef`; expand `cwd` consistently with sibling checkout RPCs. Replace `getPaseoWorktreeForCwd`'s literal `/worktrees/` fast reject with configured-root ownership resolution. The latter is older code but necessary: passing context alone still misclassifies valid roots named, for example, `/Volumes/Data/checkouts`.

**Inspected:** handler success/error responses and workspace refresh, `setCheckoutBaseRef` ownership branch, `getCheckoutSnapshotFacts`, `isPaseoOwnedWorktreeCwd`, repo config reads, and sibling `mergeToBase` context passing. Report reach was understated: roots without a `worktrees` segment are rejected too, not protected. Main repo/config behavior remains intentional; this fix must preserve it.

**Alternative:** require a resolved checkout context for all mutation APIs (production +60–100/−15–35; tests +90–150; touched 100–170). Stronger compile-time caller enforcement, but migrates unrelated mutations and adds coordination outside the demonstrated omission. Prefer existing optional context ownership with this call repaired.

**Proof:** real Git repo with two owned worktrees under custom roots both with and without that segment; invoke the session handler and verify only the selected `worktree.json` changes, repo config and sibling metadata remain unchanged, and refreshed snapshot shows the base. Include ordinary checkout repo-config write and invalid ref. A spy asserting the third argument is insufficient by itself.

**Decision:** mechanical; overlaps FP19 in checkout-git and app planner's base-control failure coverage. Share fixture setup rather than duplicate it.

## FP8 — Keep healthy Run-menu entries when one package manifest is invalid

**Covers CR1-7 (S2/F2 → P2). Default:** discovery skips an invalid or transiently unreadable manifest and continues into its children using inherited manager selection; a disappearing/unreadable directory skips that subtree. Log one contextual diagnostic per failed item. Unavailable root remains an explicit error because there is no trustworthy workspace to enumerate.

**Inspected:** recursive `discoverPackageScripts` → workspace-script `list` → `buildSnapshot`, and rediscovery in `resolveWorkspaceScript` for launch. Currently manifest JSON/Zod errors abort `list` before configured `paseo.json` scripts are returned. The configured-script launch path itself does not scan package manifests, so the failure does not make those commands intrinsically unlaunchable. Both list and launch should use the same tolerant discovery; a selected script removed from a manifest must still produce the existing actionable “not configured” failure.

**Alternative:** catch discovery once in `list`, preserving only configured scripts (production +8–18; tests +40–70; touched 15–25). Lower immediate cost, but one invalid nested manifest still removes every healthy discovered script; reject as default because ordinary monorepo editing should preserve unaffected entries.

**Proof:** real filesystem fixture with configured script, valid sibling package, malformed package, valid grandchild, and a manifest fixed between requests. Verify list and launch for healthy entries, selected missing script error, and manager inheritance. Extend focused browser Run-menu spec for recovery if the error changes UI state. No fs mocks.

**Decision:** mechanical. Shares package-scripts with FP9 and bootstrap tests with FP10; serialize overlapping edits.

## FP9 — Run package commands in the terminal shell that actually receives them

**Covers CR1-15 (S2/F0 → P2, conditional on Windows cmd default). Default:** retain discovered package manager/script identity as structured invocation data; format the launch after terminal acquisition using its resolved shell dialect, including reused terminals. Support existing cmd.exe, PowerShell, and POSIX shell paths explicitly, with safe cwd and argument handling. Do not infer syntax from `process.platform`.

**Inspected:** discovery stores prequoted command, `resolveWorkspaceScript` formats cwd before acquiring terminal, `acquireWorkspaceScriptTerminal` reuses sessions, default shell resolves to ComSpec/cmd on Windows, and terminal spawning already handles `.cmd` executable wrappers. A PTY-spawn quoting helper is not automatically safe for text typed into an existing interactive shell. This fix needs a small terminal-owned dialect interface; it must not use private shell internals or change configured `paseo.json` command semantics.

**Alternative:** explicitly launch package-script terminals in a known shell (production +35–65/−15–25; tests +70–110; touched 60–100). Fewer dialect rules but changes user's shell behavior and requires fresh terminals or shell-compatible reuse; powershell availability/startup and retained interactive sessions become new obligations. Default preserves workflows.

**Proof:** execute a package script writing cwd and received script name under real Windows cmd and PowerShell, plus POSIX. Cover spaces, apostrophes, metacharacters, drive changes, nested package manager inheritance, and reused terminal after `cd`. String-only tests cannot close Windows behavior. CR/LF script names need an explicit unsupported-input error rather than silent normalization.

**Decision:** judgment; FP8 discovery and FP10 launch edits overlap. Windows execution remains an explicit verification limit until a Windows runner is used.

## FP10 — Stop launch work after terminal death during bootstrap

**Covers CR1-21 (S2/F3 → P3). Default:** immediately after `waitForTerminalBootstrapReadiness`, verify the runtime still identifies this terminal as running. If not, leave the authoritative stopped state intact and return the launch failure; do not add completion listeners, mark working, or send command bytes. Keep the service-route cleanup path idempotent.

**Inspected:** runtime registration, exit subscription, readiness wait, late command-finished subscription, activity change, send, and outer rollback. Readiness resolves on output or timeout, not terminal exit; an earlier exit still changes the runtime through the installed handler. Current continuation can subscribe/send after that terminal is dead. Reused terminals bypass the wait but still need the same current-runtime check before send.

**Alternative:** make readiness itself return a ready/exited result and subscribe to terminal exit (production +25–45/−5–15; tests +50–80; touched 45–70). Better descriptive API for future callers, but adds a second exit listener and broadens the helper's lifecycle when the authoritative runtime already records the fact. Use only if another readiness caller demonstrates the same need.

**Proof:** deterministic typed terminal adapter emits exit while readiness is pending, then releases the wait. Assert stopped runtime and exit code persist, no new listener/send/working activity, no route leak, and launch reports failure. Cover healthy startup and reused terminal completion. No timer sleeps or own-module mocks.

**Decision:** mechanical. Integrate with FP9 in bootstrap and run the changed bootstrap test file once after both edits.

## FP11 — Apply sleep changes while an agent remains busy

**Covers:** CR1-6 S2/F1 → P2.

**Default:** Extend `SleepInhibitorOptions.daemonConfigStore` with the existing change-subscription capability. Register `onChange(evaluate)` and dispose it with the agent subscription. Existing `evaluate` already releases immediately when disabled and acquires immediately when enabled; keep its ordinary ten-second idle debounce.

**Inspected:** inhibitor startup/evaluate/dispose; bootstrap setup; config store `onChange`, `onApply`, field hooks. `onChange` happens after config owners commit, so it is the appropriate notification boundary. No new config model or timer needed.

**Alternative:** Register `onFieldChange` in bootstrap and add an explicit runtime refresh method. Equivalent behavior, but transfers ordering/disposal obligations to bootstrap and expands the runtime API. Default leaves all inhibitor triggers and teardown with the inhibitor owner.

**Size:** default production +5–12/−1–3, touched 12–25; tests +35–65/−0–8. Alternative production +12–22/−0–3; tests +45–75.

**Proof (proposed):** public runtime + injectable backend: busy agent and config-only disable releases immediately; enable reacquires without agent event; idle debounce still applies; dispose unsubscribes so future config cannot reacquire. No real OS inhibition necessary for notification logic; existing backend integration remains relevant.

**Decision:** mechanical. Coordinate with app planner's CR1-22 loading state, but that is a separate UI obligation. No daemon restart.

## FP12 — Show the sleep setting only once its value is known

**Covers:** CR1-22 (S3/F2 → P3).

**Default:** Gate `PreventSleepCard` on `config !== null` using the existing query result; preserve default-on interpretation only after an actual config payload arrives. Existing disconnected/capability checks remain. Disabled-host copy remains visible once configuration is ready. `useDaemonConfig` returns null, not undefined, before load and already exposes `isLoading`.

**Alternative:** Render a disabled loading placeholder without an On/Off assertion until loaded. Production +8–18/−2–5, English +1–2, tests +35–55. This avoids layout shift and communicates progress but needs explicit loading UI. Merely disabling the current On switch still displays the false state and does not satisfy the finding.

**Proof proposed:** Browser settings entry with real host config set false: before query data, no interactive/value-bearing switch; after hydration, Off; true config, unsupported host, mutation pending and failure retain expected behavior. Use existing config controller test seam or real delayed connection rather than mocking the hook. No hidden hardcoded timeout. Default touched production 3–8; tests 25–45; one local readiness rule, no second config state. Coordinate server CR1-6 live-reload verification, which remains a distinct finding and owner.

## FP13 — Record only settled workspace locations so Back preserves Forward

**Covers:** CR1-11 (S2/F2 → P2); also avoids latent L6 without claiming its current guard changed.

**Default:** In the recorder, skip workspace samples without a resolved selectable tab/target, including missing layouts and Explorer-only focus. This follows the selector's stated contract that Explorer selection is not a history location. Empty workspaces already have a New tab once settled. Keep normal target-retarget replacement and replay's exact tab selection.

**Inspected:** recorder, equality/push model, selector, focus/reopen/workspace-only replay, and recorder tests. History is process-local, so no persisted-entry migration is needed. Prove the first-visit race rather than relying on React effect ordering claims.

**Alternative:** Upgrade a current null-tab entry in place when a concrete tab appears. Production +15–30/−0–5, tests +90–140. This preserves transitional workspace records, but gives recorder an extra null→settled rule that must also be reconciled during replay and user navigation. Default removes those ambiguous records entirely.

**Proof proposed:** Port/unit behavior plus real browser first visit → second workspace/route → Back twice → Forward. Assert entire stack and active location, sibling closed-tab reopen, same-id retarget, nonworkspace routes, composer focus restoration and compact route transitions. Do not suppress recording globally during replay. Default touched production 10–25. Overlap routing docs FP28, but no new router ownership.

## FP14 — Make header tests assert the current workspace rather than element presence

**Covers:** CR1-8 (S2/F0 → P2).

**Default:** Replace the optional `subtitle` assertion with explicit expected presentation variants: wide git branch/base pair, compact project subtitle, and ordinary-directory project subtitle. Update callers with actual expected branch/base and assert project membership through the project/sidebar surface that owns it. The branch intentionally replaces the wide git subtitle; adding it back solely to satisfy old tests would change product layout.

**Inspected:** `WorkspaceHeaderProjectRow`, branches model, shared `expectWorkspaceHeader`, branch-switcher spec and navigation callers. The defect is lost verification, not proof of a displayed wrong project. Distinct workspace title plus sidebar project grouping and branch assertions should fail on cross-workspace leakage.

**Alternative:** Restore a distinct project label to the wide header and retain old assertions. Production +15–35/−5–10, tests +30–60/−10–20; increases header density and adds a product choice, so not default. Neither option may use DOM-count conditions to skip expectations.

**Proof proposed:** Real Playwright navigation between two named projects/workspaces with deliberately distinct branch/base pairs; compact and non-git presentations separately. Demonstrate a wrong-project/branch mutation fails the assertions; then green corrected helper. Touched tests 140–220. Coordinate `branch-switcher.spec.ts` with FP15; no route production changes expected.

## FP15 — Prove base changes and activity paging through their real boundaries

**Covers:** CR1-17 (S2/F1 → P2), one accountable parent with FP15a base-control and FP15b activity-feed proof obligations. Coverage gap is established; paging malfunction has not been demonstrated.

**Default:** FP15a extend branch-switcher Playwright over real git/daemon to assert selecting a new base updates header and comparison. Give the existing action mutation pending/duplicate prevention and persistent local error/retry state per testing docs. Trigger rejection by opening real suggestions then deleting that branch before selection; no mocked RPC. Inspect old-host refusal too, using isolated compatible-server fixture only if genuine supported infrastructure exists; otherwise report a manual compatibility gap.

FP15b move existing hook's subscription, single-flight refresh, cursor, epoch/retention reset and disposal lifecycle into one non-React controller accepting the narrow DaemonClient operations port. The hook observes it; no new global cache. Typed fake adapter tests cover hasMore, duplicate rows, invalidate-during-fetch, reconnect, retention/epoch reset, failure/retry, disconnect and late disposal. Add real-daemon/browser subscription smoke; the fake port alone is not end-to-end.

**Alternative:** Keep hook and test every branch using real daemon/browser fixtures. Production +25–50/−5–15, tests +300–480. Fewer production abstractions but expensive lifecycle seeding, harder deterministic retention/disposal races. Default replaces the hook-owned machinery rather than duplicating it; touched production 230–350. Unit proof remains public controller behavior, not private accumulator inspection. Integrate FP16 and server permission changes before final proof; base tests overlap FP14.

## FP16 — Stop work belonging to closed menus and hidden activity panels

**Covers:** CR1-13 (S2/F1 → P2). Separate obligations: FP16a recent-menu query; FP16b retained activity/thread feeds and duration clock. They can be approved independently; no shared implementation abstraction is proposed.

**Default:** FP16a read existing `useMenuContext().open` in menu content and pass it to `useAgentHistory({enabled})`; the public menu context is exported and avoids introducing mirrored parent state. FP16b use `useRetainedPanelActive()` for subscription lifecycle in the shared activity hook and for the list's interval. On reveal, resubscribe then fetch current sequenced data. Keep cached visible content while paused; daemon recording continues independently.

**Inspected:** MenuRoot/Surface, desktop caller, history query's existing enabled option, RetainedPanel, both activity and thread consumers. Shared query caching means not literally one fetch on every workspace mount. Hidden renders are bounded periodic work, not an unbounded leak. Memoizing RequestRow alone cannot stop `now` changing every row's prop.

**Alternative:** Gate only menu and duration clock; leave feed live intentionally. Production +10–20, tests +35–60. It preserves immediate reveal freshness but retains network/merge work and requires an explicit residual choice. Default reconnect has modest refetch cost.

**Proof proposed:** Typed feed port tests from FP15 count subscribe/unsubscribe and no requests while inactive, late-response disposal, reveal catch-up without duplicate rows. Real browser menu unopened/open/closed and tab hide/reveal. Default touched production 30–60; FP15 extraction first, FP16 integration second. FP15 owns paging test scaffolding so do not count it twice.

## FP17 — Bound chapter retention and finish abandoned summary requests

**Covers:** CR1-12 S2/F2 → P2; retain separate (a) chapter cache and (b) shared request ownership sub-obligations.

**Default:** Put documented count/byte limits on chapter disk cache and completed in-memory entries, including historical fingerprints, with serialized publication/pruning owned by ChaptersService. Preserve current story and pending snapshot, prefer evicting old fingerprint copies, and prune obsolete cache files on startup/first use. If current/pending content itself exceeds the chosen budget, define an explicit protected working-set exception instead of claiming a hard cap. Keep current visible story on regeneration failure.

For summaries, reconcile request ownership when a retried call is superseded, overflowed, invalidated, merged, or skipped: finish a request when its **last** live pending/active member disappears. Multiple pending calls share `requestId`; CR1's finish-on-every-drop hint can prematurely cancel a still-live batch. Do not expire genuinely active requests by age to hide the leak.

**Inspected:** chapter get/open/load/readCached/publish/run; summary enqueue/takeBatch/retry/startActivity/invalidate/dispose; recorder queue/finish/trim. Queue overflow and invalid sources delete without terminal reconciliation. Recorder sorts conversations per trim; amortized O(1) was not proven or an established contract.

**Alternative:** Keep only latest chapter per comparison plus bounded comparison count, deleting historical-copy lookup/write paths; simpler and smaller but revisiting a prior diff consumes generation again. Still requires the same request fix.

**Size:** default production +130–220/−20–45, touched 200–320; tests +150–250. Alternative production +85–145/−35–65; tests +120–200. Choose actual budgets during implementation design; no numerical user commitment assumed.

**Proof (proposed):** temp filesystem regeneration sequence exceeds test-configured limits, service restart, revisited fingerprints, failures, and concurrent comparisons preserve current/pending files. This is testable; report's 'absence cannot be unit tested' is incorrect. Actual summarizer/recorder sequence: fail batch → mutate one/all sources or overflow → last-reference cancellation only → trim reclaimed metadata. Existing retained rows may delay full eviction legitimately.

## FP18 — Give summaries a live setting without changing routing implicitly

**Covers:** CR1-14 S2/F0 → P2 historical; claim narrowed.

**Correction:** `persisted-config.ts:322` accepts `agents.toolCallSummaries.enabled`; `config.ts:651` reads it. File edit plus restart is a working opt-out. The actual missing guarantee is a discoverable live UI/RPC control; cross-provider defaults are a product/trust choice, not established unauthorized behavior.

**Default:** Preserve default-on and existing metadata provider selection pending user response. Add optional mutable config/patch fields and persisted/reload mappings; expose toggle plus plain cross-provider explanation on metadata settings. Bootstrap owns one serialized summary lifecycle: disable prevents new enqueue immediately, cancels/settles queued and active work, disposes helper resources; re-enable constructs once only after successful cleanup. Surface failure; never clear fatal refusal by toggling. Existing historical labels remain readable.

**Inspected:** persisted/default mapping, config store apply/notification contract, bootstrap conditional creation and shutdown disposals, service pause/dispose, helper close, metadata settings. Adding a reloadable path alone cannot change the startup-only summarizer object. An async generation lifecycle must not be smuggled into a synchronous config callback without an explicit desired-state owner.

**Alternative:** Default off or restrict summaries to source provider/explicit allowlist, plus same toggle. Changes feature reach/cost/model quality and fallback; choose only on user's policy answer. File-only documented restart control is lower cost but does not deliver live UI requested by the review.

**Size:** default production +120–210/−15–35, touched 190–300; tests +150–250; generated output separately. Routing restriction adds roughly +30–65 production, +50–90 tests.

**Proof (proposed):** real config patch/reload → enabled agent event enqueues; disabling mid-run stops/settles and later events do nothing; rapid off/on/off serializes; restart persists; cleanup refusal remains observable; live browser toggle failure/success. Feature gate old hosts at one settings boundary; wire fields optional. Config ownership overlaps FP11 only in integration; bootstrap ownership overlaps FP4/FP17.

## FP19 — Recover categorized stats after a preferred base branch disappears

**Covers CR1-16 (S2/F2 → P2). Default:** validate the configured `paseo.baseBranch` against local/origin refs before returning it; if unavailable, continue the existing default resolver without mutating user config. The effective resolved base should continue flowing into the header and stats, so the user can select another valid base using the existing control.

**Inspected:** setter validates at write time, resolver preference short-circuits unchecked, comparison resolution fails, and shortstat converts failure to null. The report overstates recovery: the UI base picker still offers other refs, so manual `git config --unset` is not the only route. Also, existing origin/HEAD fallback is not a universal proof that every previous resolver output existed. The product question is whether a missing explicit preference should fall back or remain visible as an error.

**Alternative:** expose missing-preference error in workspace Git state and keep stats unavailable until user chooses a valid base (production +70–130/−5–15; tests +70–120; touched 100–180, potentially protocol/app generated changes). This avoids silently switching comparison semantics, but adds wire/UI state and substantially more recovery plumbing for a readily recoverable case. Default follows existing fallback model; judgment remains explicit.

**Proof:** real Git fixture for deleted local+remote configured ref, still-existing remote-only ref, valid local preference, and restored preference. Verify effective header base and categorized totals after ref refresh, not only resolver return value. Do not clear the stored preference or mutate Git while reading.

**Dependencies:** FP7 shares checkout-git and base-control fixtures.

## FP20 — Let OS shutdown finish without waiting on the quit question

**Covers CR1-20 (historical S2/F2 → P2). Default:** own quit origin in Electron main; route supported shutdown signals through a noninteractive path using existing keep-running preference, bypass update installation, and release an already-pending dialog wait when system shutdown arrives. Ordinary user quit keeps its explicit choice. Awaited daemon shutdown must have a bounded shutdown budget; do not add a timeout that unexpectedly chooses “stop daemon” on an ordinary unattended dialog.

**Evidence correction:** installed Electron 44.2 `electron.d.ts:196–200` explicitly says Windows shutdown/logout does **not** emit `before-quit`. `query-session-end`/`session-end` belong to windows, not `app`. The report's Windows prompt mechanism is rejected. macOS/Linux `powerMonitor.shutdown` is available; its native ordering and macOS logout behavior still require verification. Missing listeners alone does not prove every OS shutdown blocks.

**Alternative:** only suppress prompts on `powerMonitor.shutdown` (production +15–30; tests +30–55; touched 25–45). Much simpler, but fails if ordinary quit is already waiting or daemon/update work exceeds shutdown time. Default adds one authoritative quit origin and cancellation path; avoid a second independent shutdown state machine.

**Proof:** typed event-source tests for ordinary choice, signals, shutdown-before-quit, shutdown-during-dialog, repeats, and updater handoff; then isolated installed-app macOS restart/logout and Windows session-end smoke on disposable hosts. Native tests are necessary for full claim closure and cannot be run on the user's active session. No main daemon restart.

**Decision:** judgment; exact shutdown budget and daemon preference semantics need explicit selection. Shares `main.ts` with FP29.

## FP21 — Keep script-menu behavior covered without new fake UI machinery

**Covers:** CR1-18 (S2/F2 → P2).

**Default:** Compare branch-added JSDOM cases with `workspace-package-scripts.spec.ts`, transfer unique assertions, then remove added cases and newly exclusive mock support. Existing browser coverage already verifies discovery, nested launch, completion, scrolling, case-insensitive name search and compact behavior. It does **not** cover the JSDOM case's multi-token package-path search (`WEB build`) or clearing search restoring collapsed groups; preserve these before deleting.

**Alternative:** Extract a pure filtering/group-selection model with typed input and test it, retaining browser launch/error checks. Production +35–65/−20–40; tests +70–110/−170–220. Appropriate if logic itself is changing, but unnecessary solely to replace existing assertions and retains two behavior layers to coordinate.

**Proof proposed:** Focused real-browser script spec green after additions and deletions; search nested path/name together, clearing collapse state, independent groups and exact launched package; no whole-suite run. Do not erase older unrelated tests as part of this task. If shared mock removal breaks old tests, retain the old shared support rather than expanding cleanup.

**Dependency:** CR1-7 changes malformed-package behavior. The existing Playwright test currently expects malformed nested JSON to fail the entire menu; replace that expectation with partial discovery plus a separate real transport/disconnect failure test as part of that server plan. Default touched tests 210–285. Tell server planner about this contract change before implementation.

## FP22 — Give activity producers one semantic identity and preserve existing wire shapes

**Covers:** CR1-19 S2/F2 → P2.

**Default:** Add one canonical internal activity identity with centralized legacy wire projection and display normalization for the existing four purposes. Producers supply `chapters`, not `pull_request` plus a special field. Keep existing wire `kind` and optional literal `purpose` readable and emit only values existing clients accept; app consumes one normalized purpose and label map. This removes producer obligations without inventing future feature types.

**Inspected:** BackgroundRequest schema; recorder RequestInput/create; chapters and labels creators; activity-panel title/count logic. Widening `purpose` from literal to string on new clients does **not** let old clients parse arbitrary emitted purposes. CR1's suggested widening alone violates backward compatibility as soon as a new value is sent.

**Alternative:** Add optional free-string `activityType` as the canonical wire identity, retain legacy projection for older clients, normalize absent identity once on new clients. This supports unknown future identities and a fallback label, but adds a third wire field and permanent projection until the compatibility floor moves. It is credible if a new activity type is being added now; branch-name activity is not in scope merely because the review calls it an obvious future task.

**Size:** default production +45–80/−15–30, touched 80–130; tests +35–65. Alternative production +55–95/−15–30, tests +60–95, generated output separate.

**Proof (proposed):** existing and old-shape messages parse; all existing purposes label/count correctly; producers cannot choose contradictory combinations; optional alternative must test old schema parsing unknown new identity with legacy fields projected safely. Judgment: prefer default for current scope. Serialize protocol edits with FP6/FP18/FP23.

## FP23 — Correct protocol annotations without breaking deployed names

**Covers:** CR1-25 S3/F0 → P3: four capability annotations, unused advertisement, noun RPC/unpaired event documentation.

**Default:** Add accurate introduced-version/date/floor comments at actual compatibility gates. Stop advertising unused `toolCallDescriptions` while retaining its accepted optional field. Document the existing `snapshot` noun spelling as legacy compatibility, and document `background.activity.changed` as an unpaired subscription event near schema. The desired naming exception is a judgment decision; don't call it mechanically corrected merely by adding a comment. No evidence this branch's wire names have never been consumed, and project forbids removal.

**Alternative:** Add canonical `background.activity.get_snapshot.request/response`, retain old request/reply pair in schema and handler, advertise/gate new capability once; migrate current client. Subscribers keep existing changed event with explicit note. This fully meets future naming convention but duplicates a pure read RPC, adds compatibility code and tests, and new-client access to old hosts must follow no-fallback feature policy. Do not rename in place.

**Size:** default production +10–20/−1–3, touched 20–45; tests 0–15 inspection/contract checks. Alternative production +65–110/−8–15; tests +45–80; generated output separate.

**Proof (proposed):** old and current messages/features still parse; capability tags use actual version (do not invent from current date); default no behavioral tests solely asserting comment text. Alias alternative transport verifies each request returns its matching response and current capability boundary is visible. Depends on FP22 and FP18 protocol decisions; avoid gating ordinary optional summary metadata purely to manufacture a consumer.

## FP24 — Normalize chapter paths at the checkout boundary

**Covers:** CR1-26 S3/F3 → P3.

**Default:** `handleChaptersGet` passes `{...msg, cwd: expandTilde(msg.cwd)}` into service, consistent with checkout-session siblings. Keep service's absolute resolution and canonical cache key. App sends absolute cwd already; issue affects direct protocol consumers using tilde.

**Alternative:** Teach ChaptersService to expand user paths itself. Fewer caller obligations for possible future consumers, but introduces user-shell notation into a storage/domain service whose other inputs are normalized. Current sole session entry point supports a small boundary fix.

**Size:** production +2–4/−1, touched 3–8; tests +15–30. Alternative similar production/test size.

**Proof (proposed):** session transport through real isolated home checkout proves tilde and equivalent absolute paths target same diff/cache entry; missing path error remains correlated/visible. Do not manipulate the process HOME in shared tests. No comprehensive shell/path parser needed. Mechanical, overlap session handler with FP6; apply together or sequentially.

## FP25 — Make pulse deadlines deterministic without replacing the real animation

**Covers:** CR1-23 (S2/F3 → P3).

**Default:** Extract the pulse schedule/lifecycle into a small owner accepting clock/timer and animation-start/stop ports. Hook adapts Reanimated, retained activity and reduced-motion inputs. Test exact expiry, late mount, new attention, state clear, inactive retention and disposal using a typed manual clock. Keep real-browser smoke for visible pulsing and OS reduced-motion via browser emulation; move mock-heavy browser checks to permitted real-app coverage.

**Alternative:** Give hook an optional timer/now dependency and exercise it through a real browser harness. Production +15–30/−5–10, tests +80–130/−45–75; smaller but hook lifecycle remains coupled to mounting and the prohibited module-mock setup still needs replacement. Loosening poll timeouts leaves the race intact.

**Inspected:** Hook's immutable original deadline, Reanimated start/stop, browser test's 1.5-second window and 850-ms sleeps. This is test determinism, not evidence the runtime pulse is wrong. No change to 60-second deadline or 750-ms animation.

**Proof proposed:** Unit scheduler guarantees at exact boundaries, not timing-based opacity polls; Playwright real animation eventual dip plus reduced-motion solid rendering; native smoke still needed because browser does not prove Fabric animation. Default touched production 70–115, tests 150–230. New owner must replace old timeout logic, not add a parallel timer model.

## FP26 — Store screenshots where runners isolate and collect them

**Covers:** CR1-24 (S3/F1 → P3), both Playwright and Vitest locations.

**Default:** Add testInfo parameter to change-breakdown Playwright case and use `testInfo.outputPath` for all three screenshots. For Vitest chapters, omit absolute path and let configured `.vitest-screenshots` choose test-specific output; inspect installed provider API for unique names when needed. Ensure CI artifact upload includes that configured directory, or place it under already uploaded test output. Playwright's API cannot be pasted into Vitest.

**Alternative:** Remove unconditional screenshots and rely on automatic failure screenshots. Tests −4–8, config 0. This reduces artifacts but loses explicitly requested visual evidence of passing compact/wide states, so default keeps them.

**Inspected:** Both tests, app Vitest screenshotDirectory, Playwright config and CI upload paths. Current Vitest browser project serializes files, narrowing collisions there; absolute `/tmp` still bypasses its ownership/collection. Windows portability is inferred, no Windows run.

**Proof proposed:** Run only changed cases, inspect returned paths/artifact contents and distinct compact/wide names; inspect CI config inclusion. No new snapshot assertion is required merely to validate filenames. Default touched tests/config 12–25. Overlap FP30's chapter browser test; integrate once and run once.

## FP27 — Make terminology and Explorer documentation agree

**Covers:** CR1-27, CR1-28, CR1-29 (each S3/F0 → P3), with explicit obligations for glossary/copy, Explorer lists, summary-store placement, and timeline index.

**Default:** Add concise glossary entries for Chapters, Background activity, Pinned prompt and Recently closed, update Explorer entry; keep code namespaces unchanged. Rewrite Explorer doc to distinguish default views, optional launchable views and compact overlay surfaces instead of repeating inconsistent enumerations. Integrate tool-summary storage into the existing numbered store organization. Add timeline-sync row to CLAUDE's index, describing its existing delivery/inspection ownership.

**Recalibration:** `recentAgents` is an internal namespace, not itself a user-facing synonym; “Read changes as a story” can be a metaphor, not a second product name. Prefer “Building chapters…” and “chapter snapshot” where terminology is genuinely ambiguous, without renaming `ChapterStory` on wire or mass-changing generated prose. Timeline-sync pre-existed: missing index entry is omission, not a newly created document violation.

**Alternative:** Only update index and stale lists, leave new glossary terms/copy untouched. Docs +15–30/−10–20, production 0; smaller but leaves canonical naming discoverability unresolved, so not a full substitute absent an explicit disposition.

**Proof proposed:** Fresh inspection crosschecks manifest/launcher and compact shell against one authoritative doc, links/anchors resolve, English usages match glossary. No tests that mirror prose. Docs touched 65–110. Integrate with FP28 and server cache/retention documentation changes; no unrelated hub-index cleanup.

## FP28 — Document the PR navigation contract and what change statistics mean

**Covers:** CR1-30 (S3/F0 → P3), FP28a PR browser/route contract and FP28b change-stat semantics.

**Default:** Integrate PR browser workflow/capability expectations into owning product/forge material, and serialized `changeRequest` initialization contract into `docs/expo-router.md` Params. Explain that route state carries checkout identity/title rather than PR body/checks/stats; invalid state is ignored by schema parse and remount keys restart the create form. Explain categorized totals, production subset and `commentsIncluded` as uncertainty already included in production counts, not an extra additive category, beside git-stat architecture documentation. Link classifier code instead of pasting fourteen regex rules.

**Inspected:** PR select callback → serialization → `/new` parse/screen remount; `classifyPath`, `classifyDiff` and protocol totals. Need targeted inspection of final create-workspace checkoutSource consumer before documenting that continuation as verified.

**Alternative:** One short new `docs/change-review.md` owns review workflows/stat rationale, with index and routing links. Docs +60–95/−0–5. Better if no existing owner fits after FP27, but introduces another subject boundary and must not duplicate routing/stat facts. Default uses existing owners and records only non-obvious cross-module constraints.

**Proof proposed:** Fresh documentation review against final implementations plus link check; no fabricated behavior tests. Default docs touched 40–75. Wait for CR1-2 performance strategy to settle before describing freshness; do not document proposed cache logic as current behavior.

## FP29 — Give native quit copy an English resource owner without requiring a renderer

**Covers CR1-31 (S3/F1 → P3). Default proposal:** move native dialog text into a small desktop-owned English resource dictionary and document this native resource boundary in the existing i18n owner doc. Keep confirmation native and available when every app window is closed or the renderer failed. No non-English work.

**Inspected:** `main.ts` confirmation and shutdown feedback, app `desktop.quitting.*` strings, desktop package/tsconfig, docs/i18n. The existing renderer text is a progress overlay (“Quitting…”/“Stopping…”), not equivalent confirmation copy. Desktop has no i18n runtime and its TypeScript rootDir is `src`; importing app `en.ts` directly creates cross-package build coupling. Hence report's “move confirmation into renderer” is not a mechanical correction.

**Alternative:** renderer owns the confirmation using new English keys and an IPC request/result lifecycle (production +100–180/−10–20; tests +60–110; touched 140–240). Obeys current app-resource location literally but introduces window election, renderer readiness/crash handling, shutdown ordering and native fallback or lost quit functionality. That is disproportionate for English-only copy hygiene.

**Tradeoff/decision:** judgment because docs currently name app en.ts for English source strings. Select a narrow native-resource convention explicitly; do not claim extraction alone complies unchanged with that convention. This is a policy adjustment rather than accepted user-visible defect. No choice is yet authorized.

**Proof:** inspect one resource owner for all dialog strings, run desktop typecheck/build, and smoke the same native prompt with no renderer available. No wording-mirror test. FP20 owns all quit lifecycle proof; FP29 adds no overlapping lifecycle fixture.

## FP30 — Keep model instructions out of UI translation and simplify resource use

**Covers:** CR1-32 (S3/F3 → P3), four obligations: handoff instruction, count key, retry reuse, and enum-key mapping.

**Default:** Build the handoff instruction as agent-directed text beside the draft creation logic and keep UI feedback translated. Replace chapters retry call with existing common retry; remove dead base count value while preserving `_one`/`_other` behavior under actual i18next. Replace chapter test's handwritten translation function with real English i18next; otherwise it incorrectly depends on the dead base key. For background labels use explicit protocol-kind→UI-key mapping if CR1-19 introduces it; no gratuitous wire enum rename.

**Recalibration:** `docs/i18n.md` explicitly excludes agent **output**, not literally every agent-directed instruction. English-only fork means today's handoff text does not actually change by locale; this is ownership cleanup, not a demonstrated behavior bug. Snake-case UI key is style unless future mapping changes establish coordination cost.

**Alternative:** Move only handoff instruction and reuse retry, leave plural aliases and enum-named keys. Production +3–8/−3–8, tests +10–20; less churn but incomplete against original hygiene claims unless remainder gets an explicit rejection/disposition based on these facts. Default does not imply permission for other locale edits.

**Proof proposed:** English real-i18next plural 1/2 counts, handoff draft retains exact instruction/body/source link, retry visible label unchanged, both activity list/thread labels. Default touched production 30–55, tests 35–60. Serialize en.ts, chapter browser test (FP26/FP27), plan-handoff button, activity presentation with CR1-19 owner; avoid duplicated map creation.

## Guarded hazards and related proof obligations

These do not duplicate CR findings; connections name where any authorized correction belongs. Keep guarded hypotheses as follow-ups, not live risk acceptance. All statuses remain open/proposed here.

| ID  | Planning treatment and inspected correction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | Current app calls both helpers with `story.files`, the same snapshot validated by service/cache; fingerprint mismatch is **not** the sole guard as CR1 says. No current mismatch found. Preserve tests around story-owned files; future externally supplied section/file pairing must validate at that new boundary. Extra throw alone still crashes a renderer and is not a meaningful robustness fix without a recovery owner. No product edit recommended now; revisit when helper accepts independently sourced data.                                                                                                                                                          |
| L2  | Add boundary validation/canonical object resolution in statistics reader if changing it for CR1-2/5; reject option-prefixed refs, preserve supported legitimate refs, use `--end-of-options` only for Git forms supporting it. The report's proposal to put `--` **before refs** turns refs into pathspecs and is incorrect. `assertSafeGitRef` allows leading `-`, but rejects `=`, limiting the claimed `--output=` attack through that guard. Exercise malicious option refs from direct reader/config and real Git; don't introduce dependency from low-level Git reader into session class. Additional production ~10–30/test +25–45, integrated with stats plan if selected. |
| L3  | Same trust boundary as running repository script body; resolve quoting using actual terminal shell in CR1-15 plan. No separate security feature/change authority claimed. New automation that runs discovered names without explicit script selection reopens trust question. Newline rejection requires decide whether script-key support narrowing is acceptable, not an unrelated automatic rule.                                                                                                                                                                                                                                                                               |
| L4  | Counter accounting drift is reachable from concurrent cache misses today, not protected by a true upstream guard. Fold replacement accounting/in-flight dedupe test into CR1-2 cache owner: count previous value subtraction before overwrite; bounded eviction handles no entries. Real concurrent identical immutable reads + forced eviction must not throw or overcount. Additional production ~5–15/tests +25–45 if current cache retained; replacement design can eliminate old counter.                                                                                                                                                                                     |
| L5  | Preserve fail-safe pause after unacknowledged cancellation; it prevents additional uncontrolled helpers. Recommend observable reason via existing background request error (check already finished failure) and setting status under FP18. Never reset fatal flag or resume on arbitrary config reload while original helper may still run. Recovery needs positive acknowledgment/closure or daemon restart, which is not authorized here. Current behavior is deliberate supported containment, not a silent lost-cancellation fix.                                                                                                                                              |
| L6  | Parent's history plan should cover first-visit/null tab semantics. Explorer focus is currently guarded as report says; avoid wiring focus just to demonstrate latent break. Contract test existing-layout Explorer focus does not erase history when future focus path is introduced. App planner owns choice; no duplicate runtime work.                                                                                                                                                                                                                                                                                                                                          |
| L7  | Current resourceKey intentionally reuses one chapter pane and current deterministic ID agrees. No present duplicate proven. Preserve single-pane semantics; when independent chapter tabs become supported, derive resource key and ID together and prove uniqueness. No preemptive ID change because persisted tab identity may be affected.                                                                                                                                                                                                                                                                                                                                      |

## Integration order and boundaries

- FP1 is independent and first. FP13 shares layout/history proof but should not alter tab
  persistence while the first fix is under verification.
- FP2/FP3 share statistics read/cache ownership. Include L2/L4 in that boundary's regression
  proof. A worker is an alternative only if measurement justifies its lifecycle/package cost.
- FP4, FP17, FP18 and FP22 share background generation/recording; serialize changes and give
  one owner end-to-end queue, disable, cancellation and retention proof. Preserve fail-safe
  suspension after unacknowledged cancellation.
- FP6/FP18/FP22/FP23 share protocol/client/session contracts. Build generated declarations and
  review both version directions once for the integrated change. Generated output is separate
  from source estimates. FP24 shares the chapters session boundary with FP6.
- FP7/FP19 share base resolution; FP14/FP15 own real header/base browser proof. FP19's default
  continues existing fallback resolution after a missing preference, which changes the effective
  comparison; select its explicit-error alternative if preserving that preference is required.
- FP8/FP9/FP10/FP21 share scripts/bootstrap/browser proof. Replace the old browser expectation
  that malformed JSON empties the menu; retain a separate real transport failure scenario.
- FP15 owns shared activity controller test scaffolding; FP16 then gates hidden work. FP15's
  extraction is a judgment choice. Its real-daemon/browser-only alternative avoids a new
  production seam if the necessary races can be reproduced deterministically there.
- FP11/FP12 cover different setting obligations with shared live UI proof. FP20/FP29 share
  desktop main; preserve native prompt availability when no renderer exists.
- FP26/FP27/FP28/FP30 overlap English resources, chapter browser tests and docs. Integrate
  facts into owning docs after behavior settles; no non-English maintenance.

Do not opportunistically repair the four optional maintenance suggestions from CR1. Cache
work already needed by FP2 may absorb its related suggestion. Shared quoting only belongs
where the actual shell contract is established by FP9. The first-session dependency capture
and optional ChangeStats feature gate remain unproven follow-ups, not accepted defects.

Previously unreviewed inline-comment geometry, chapter diff-index mapping, native animation,
provider-specific behavior and chapter disconnect cancellation remain coverage limits. This
plan does not turn them into new findings or claim that a green general gate verifies them.
The English-only locale policy already authorizes divergence; no redundant sign-off required.

## Verification and round outcome

Executed by the orchestrator after creating this records-only ledger:

- `npm run typecheck` — exit 0 across workspaces; log `/tmp/fix-plan-typecheck.log`.
- `npm run lint` — exit 0, zero warnings/errors; log `/tmp/fix-plan-lint.log`.
- `npm run format:files -- findings/FIXES-introduce-pr-diff-chapters.md` — exit 0; formatted this ledger.

No new tests, performance runs, provider executions, platform smokes, source changes or
closure verification were performed. No main daemon restart, commits, pushes, or external
messages. All 33 findings have exactly one plan owner. Guarded hazards retain their explicit
revisit conditions; no residual is accepted on the user's behalf.

After authorized implementation, run red then green for FP1 and the demonstrated FP2 failure
through the actual product path. Run only each changed Vitest file with
`npx vitest run <file> --bail=1` in its package. Use named browser specs, for example
`npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/branch-switcher.spec.ts`,
and the specific package-script/composer cases. Never run the full local suite.
Run required typecheck/lint; if declarations are stale, rebuild owning stack with
`npm run build:client` or `npm run build:server` before diagnosing type errors.
Use npm formatting scripts. Require a fresh read-only verifier for each completed guarantee
or integration batch; keep platform/provider limits explicit. Nothing here authorizes
claiming a fix closed based solely on passing typecheck or lint.
