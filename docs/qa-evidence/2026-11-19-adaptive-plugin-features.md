# Adaptive plugin features: source verification

- Record date: 2026-11-19. Clock checked with `date '+%Y-%m-%d %H:%M:%S %Z'`: `2026-11-19 22:30:48 IST`.
- Status: source corrections and bounded verification complete. The single light review found one queued-live-snapshot gap, independently confirmed, then fixed and regression-tested without another review round. M authorized six feature-branch commits/pushes and draft PRs only; no npm, tag, store publication, installation or port-6767 restart. Morphise was explicitly fast-forwarded to v0.47.0 and revalidated before draft publication. Clock checked: 2026-11-20 08:55 IST; original record filename retained.
- Local implementation plan: `paseo-provider-plugin-compatibility/docs/2026-11-19-1624_adaptive-plugin-features_plan.md` in the sibling working checkout; it is not part of this published repository.
- Local accepted decision record: `paseo-provider-plugin-compatibility/docs/adr/0001-derive-plugin-features-for-each-session-open.md`. The goal, decisions and safety boundary are restated below so this evidence does not require that local file.
- Prior evidence: integration/copy/lifecycle/manager/build/typecheck/lint/format and visual checks PASS; actual built-CLI redaction characterization PASS1 (49 deselected/50 total).17 representative mutants restored. Current fixes add empty fixed-opening, retained-prefix and consumed-policy regressions before a second independent review. Routed/Codex and release limits remain explicit.

## Current review corrections (provisional)

### Second-review disposition, 2026-11-20

The second fresh reader returned four draft blocking findings and one must-verify item. Independent source refutation retained all four blockers, narrowing provisional-session impact to cleanup ownership and launch finalization after uncertain closure. M approved all remaining fixes and one light focused review only. Universal live-credential invalidation is not established. The fixes below are verified. The light review's sole additional queued-snapshot finding was also independently confirmed and corrected; no additional review pass is claimed.

### Final focused correction and publication boundary

The light review found that capturing safe options only at closure did not protect already-materialized live updates waiting for enrichment. The manager now captures a detached safe view whenever it materializes an agent snapshot, including get/list, replay, registration returns, state emission and closure. The internal symbol survives object spreads but is excluded from JSON. Capable clients retain actual values. A deterministic test holds enrichment, closes the session, then releases both the older idle update and the closed update. Both unopted updates stay safe while the capable view remains actual. The regression failed before the correction. [verified: `adaptive-queued-{red,focused-green,manager,service,projection}.log`; `agent-manager.ts` snapshot factory; `session/agent-updates/agent-updates-service.test.ts` held-enrichment case]

Final owning checks: manager323, agent-update service35 and projections64 PASS. Combined server build, full workspace typecheck, tool50, selected resume/reconstruction11, MCP196, schedule77 and five real plugin subprocesses all PASS exit0 in `adaptive-queued-final-checks.log`. The composed fixture covers supported/fixed/limited/restored, exact retained credentials/current prefix, initially empty fixed opens, unchanged protected state, zero model turns and zero computer-engine calls. Scoped lint and read-only formatting passed before the final documentation update and are rechecked by publication preparation.

Morphise's remote main advanced to v0.47.0 during publication preparation. M explicitly approved preserving the adaptive diff, fast-forwarding this isolated worktree, and restoring it. Reapplication merged cleanly; the named recovery stash and external patch remain local. Its HTML45, task-list19, incoming conversation-search suite and typecheck passed after integration in `adaptive-morphise-v047-verification.log`. No incoming UI code was discarded.

This publishes reviewable source, not an installable release. Official host/SDK versions and all plugin dependency/manifest floors remain unchanged until an upstream release actually contains the adaptive contract. Proposed plugin prerelease versions belong in draft PR notes; no release tag or npm package is created. The host draft includes and depends on compatibility PR [#10209](https://github.com/getpaseo/paseo/pull/10209); integration with newer upstream main and CI remain merge gates. Native/live-provider QA, routed app runtime proof and conservative Codex approval limits remain explicit.

| Correction                                 | Verification after red-first regression                                                   | Current result                                                                                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Partial reset dependencies                 | `adaptive-review-reset-{red,final,mutant}.log`                                            | 37 helper tests pass; newly broken endpoint/grant dependencies reject, stale/incremental recovery remains allowed; recovery mutant killed and restored byte-identically         |
| Public-resume archive rollback             | `adaptive-review-resume-{red-confirmed,cases}.log`                                        | Original archive timestamp lost on red; all 10 public-resume cases pass after moving projection inside rollback                                                                 |
| Closed snapshot copy safety                | `adaptive-review-closed-{red,green,projection,final-mixed}.log`                           | Real unopted-client leak reproduced; 50 tool cases and 64 projection cases pass with detached internal symbol capture, capable-client values unchanged                          |
| Pending pre-registration runtime ownership | `adaptive-review-pending-{red,final-green,manager-final-green}.log`                       | Ownership loss reproduced; five regressions and 323 manager tests pass; rejected close remains explicitly owned and recoverable                                                 |
| OpenCode interactive resume permissions    | `adaptive-review-opencode-*.log` and version-matched OpenCode 2.0.10 server/client source | Missing update reproduced; 73 agent tests and 5 configuration tests pass, including empty replacement, authored ordering, retained sessions, history skip and rejection cleanup |

| Item                             | Source-confirmed issue                                                                                                                                                                | Proposed owning-layer correction                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Closed update copy safety        | `agent-manager.ts:1293-1335,5170-5202` loses session option ownership after removal, while `agent-updates-service.ts:333-343` still serializes the old effective options              | Carry detached copy-safe state or ownership with the emitted snapshot, rather than reconstruct it from current residency                         |
| Pre-registration close rejection | `agent-manager.ts:4973-4977,5015-5020,6461-6471` logs close rejection without retaining a retryable manager cleanup handle; lifecycle finalization then disposes uninstalled launches | Give pre-registration sessions explicit cleanup ownership until closure is confirmed; do not infer provider survival from a rejected close alone |
| Partial reset dependencies       | `plugin-config-adoption.ts:490-510` can remove a grant receipt while leaving its dependent endpoint receipt, which fails `validateEndpointReceipts`                                   | Validate dependency consistency of the remaining receipts atomically while preserving stale-fragment reset recovery                              |
| Failed public resume             | `session.ts:5204-5225` obtains the template after unarchive but before entering archive rollback                                                                                      | Put every fallible preparation step after unarchive inside rollback, or project before mutation                                                  |
| OpenCode resume rules            | `opencode/v2/agent.ts:185-198` and `configuration.ts:45-65` apply mode/model but never send current mapped permissions                                                                | Prove the adapter resume contract with a deterministic regression and version-matched API semantics before advertising adaptive rule updates     |

The source findings above are their pre-fix evidence, not claims about current behavior. The named regression logs establish the corrections; final combined verification and the light-review correction are recorded above. No installation, npm publication or release tag occurred.

Round 1 was a partial source review with three blocking findings. Separate attempts to refute each finding confirmed it; none had a runtime reproduction at that review checkpoint. The red-first regressions below now reproduce the defects. This section supersedes earlier completion/review-status claims, not their recorded passing checkpoints. M approved fixing all three and a second fresh review while keeping release paused. [verified: parent review/refutation reports and approval, 2026-11-19; named red logs below]

| Blocking finding                                                                                                                                       | Owning correction                                                                                                                                                                                                                                                                                                       | Current evidence                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fixed MCP configuration incorrectly required a prior owned binding even when the contribution stayed empty, was Off, or was suppressed by caller state | Memorise, Contextualise, Computerise and the same Morphise HTML variant now distinguish an actual owned binding from an empty/unowned group. Empty fixed opens allocate no new MCP binding; compatible instruction-only features remain eligible. Incompatible existing owned bindings still require full close/reopen. | Plugin source owners: Memorise `server/plugin.ts:252-327`; Contextualise `server/knowledge/plugin.ts:533-627`; Computerise `server/plugin.ts:253-275`; Morphise `server/polish/pages.register.ts:53-98`; red/green table below |
| Memorise fixed reuse replaced the current cumulative instruction prefix                                                                                | Its open-hook merge appends its retained own instructions after the current incoming prefix, rather than replacing earlier plugins' contributions.                                                                                                                                                                      | `memorise-adaptive-features/server/plugin.ts:292-298`; prefix regression in `adaptive-review-memorise-red.log` and targeted green; composed integration                                                                        |
| Adopting the last plugin-only grant left an empty required policy that blocked OpenCode                                                                | Required-base projection removes the exhausted policy and its plugin provenance only after grant adoption consumed it. Caller-required empty policies remain strict.                                                                                                                                                    | Host `packages/server/src/server/agent/plugin-config-adoption.ts:224-230`; `adaptive-review-policy-red.log` and `adaptive-review-policy-green.log`                                                                             |

All paths/log names below use the worktrees and raw-log root already recorded in this document. Counts describe the named runs, not every provider/platform path. Typecheck exit0 results are parent-confirmed execution results; their log files contain commands without exit trailers. [verified: retained logs and parent worker-result reports]

| Owner                      | Red-first regression evidence                                                                                            | Green verification after owning fix                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host projection / OpenCode | 1 failed assertion: projected config still had `toolPolicy`; `adaptive-review-policy-red.log`                            | Adoption27 and OpenCode66 PASS exit0; exact commands/trailers in `adaptive-review-policy-green.log`                                                                                                                                                                                      |
| Contextualise              | 4 failed; `adaptive-review-contextualise-red.log`                                                                        | Focused4, owning knowledge-plugin suite111, typecheck exit0; `adaptive-review-contextualise-{green,plugin-suite,typecheck}.log`                                                                                                                                                          |
| Memorise                   | 6 failed, then 2 additional notes-only failures (8 distinct regressions); `adaptive-review-memorise-{red,notes-red}.log` | Focused8, owning plugin suite76, typecheck exit0; `adaptive-review-memorise-{targeted-green,module,typecheck}.log`. Worker additionally ran26 files/383 tests PASS in `adaptive-review-memorise-suite.log`; historical evidence only, not a recommendation to repeat a full local suite. |
| Computerise                | Initial2 failed; expanded boundary run3 failed/1 passed; `adaptive-review-computerise-{red,red-boundary}.log`            | Focused13, owning plugin suite68, typecheck exit0; `adaptive-review-computerise-{green,plugin,typecheck}.log`                                                                                                                                                                            |
| Morphise                   | 8 failed; `adaptive-review-morphise-red.log`                                                                             | Owning pages suite45 and typecheck exit0; `adaptive-review-morphise-{green,typecheck}.log`                                                                                                                                                                                               |

Updated composed harness `adaptive-review-actual-plugins.integration.ts` PASS exit0, fixture `adaptive-review-actual-plugins-bgox6K`: five real plugin subprocesses; supported/fixed/limited/restored; identical fixed MCP credentials and current instruction prefix; initially limited then empty fixed; ordinary prompts, caller bindings, collision/permission negatives, history, unchanged protected settings/data, zero engine calls and model turns. This supersedes Mo9TbR for these newly composed transitions. It remains a deterministic provider fixture, not native or real-provider smoke. [verified: `adaptive-review-actual-plugins.log:1-3`; parent execution result]

### Detection gap and recurrence prevention (RCA)

The original tests exercised valid fixed-binding reuse but omitted first-fixed/empty-owned states and composition with an earlier plugin's current instructions. Blanket fixed-open error expectations encoded the wrong invariant: fixed configuration forbids changing a binding, not preserving its absence. The adoption tests also missed consuming the final plugin-only grant through the provider boundary. Those omissions let the three defects survive earlier green checkpoints. [verified: parent round-1 review/refutation reports; subsequent named red regressions]

The owning regression matrix now separates absent/suppressed bindings from incompatible live owned bindings, preserves instruction prefixes, and covers exhausted plugin-only versus caller-required policies. These assertions and the composed fixture are the prevention mechanism; no runtime retry, fallback or broader approval was added. RCA ownership stays here and is linked from the authoritative plan; no separate RCA file. [verified: owning fixes/tests and red/green evidence above]

Post-correction static checks: host `npm run build:server` and full `npm run typecheck` PASS exit0 (`adaptive-review-build-static.log:78,147`); scoped host lint PASS exit0 with0 warnings/errors across83 files (`adaptive-review-lint.log:5-6`; parent exit report). Parent reports six-worktree `git diff --check` PASS exit0. The owning READMEs/OVERVIEWs now qualify fixed restrictions by binding ownership, and host `docs/data-model.md` records exhausted plugin-policy absence versus strict caller-required empty policy. No dependency/version changes were made. [verified: named logs; parent source/diff checkpoint report, 2026-11-20]

Post-correction downstream consumer reruns PASS exit0: projection62, manager318, MCP196, schedule77 and public-resume3 selected/43 excluded. Exact commands and exit-0 trailers are retained in `adaptive-review-consumer-tests.log:11,22,33,44,55`; assertion summaries are at6,17,28,39,50. These are new post-correction passes, not substituted historical counts. [verified: named consumer log]

The two full source reviews and the one requested light review have concluded. Material retained findings were fixed with regression coverage; the light review's queued-update correction was verified by tests, not another review pass. Draft source publication is authorized, while official release metadata, npm/tags and installation remain gated as described above. No install-ready or all-platform claim is made.

## Pre-review outcome and bounded limits

The five plugins adapt supported/limited/restored contributions without changing protected fixture settings/data. Required caller policy remains strict; native attached tools survive missing HTTP where eligible. Public resume, no-native reconstruction/history and unmatched handles pass their three new boundary cases; old-SDK snapshots feed real new-agent creation without copying optional values. No engine/model/production operation was performed. [verified: final actual-plugin/copy logs and owning assertions]

| Final gate                                              | Result                                                                                 | Evidence                                                                      |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Actual five-plugin subprocess integration               | PASS exit0; fixture `adaptive-actual-plugins-Mo9TbR`                                   | `adaptive-final-actual-plugins.log`; acceptance JSON; execution transcript    |
| Final copy/lifecycle/manager batch                      | PASS exit0:3 selected (43 skipped),49,318                                              | `adaptive-final-copy-tests.log:5-33`                                          |
| Recipe/worker boundaries and representative sensitivity | PASS25/74;17 mutants killed/restored                                                   | Boundary green logs; strict-guard worker transcript; prior mutation artifacts |
| Browser/visual                                          | App13 including hello; actual header1/four states/eight screenshots; panel12           | Combined report, `newadaptive-header-only.log`, header/panel JSON             |
| Server/SDK/app dependencies                             | PASS exit0                                                                             | `adaptive-final-build-static.log:78,129`                                      |
| Latest full host typecheck after test edits             | PASS exit0                                                                             | `adaptive-final-typecheck.log`; actual execution notification                 |
| Five plugin typechecks                                  | PASS exit0 each after declaration staging                                              | `adaptive-final-plugin-typechecks.log`                                        |
| Final scoped lint after source/test edits               | PASS exit0, no disabled rules                                                          | `adaptive-final-lint.log`; execution notification                             |
| Diff/scope, branches and uncommitted state              | PASS; `git diff --check` exit0, all six branches correct; no staged commit/publication | Parent final diff/branch audit transcript                                     |
| Final read-only formatting                              | PASS exit0; all93 matched files correctly formatted                                    | `adaptive-final-format-check.log:5-8` and parent actual execution result      |

Two bounded source-proof limits remain, not an open-ended request to map all paths:

1. **Codex optional additive approval:** no live/additive mapper certification; resolver intentionally stays `unknown`, retains ordinary prompts and never uses the catalog-narrowing required-policy mapper for optional conveniences. Existing strict required policy is unchanged.
2. **Routed app capability opt-in:** direct actual hello and unopted SDK behavior are runtime-tested; routed/probe factory opt-in is source-inspected, not separately runtime-tested. No claim of routed runtime proof.
   Actual CLI redaction is now proved by a subprocess characterization: the built CLI runs through `process.execPath`, explicit isolated `--host` and temporary HOME/PASEO_HOME; candidate labels remain visible, five dummy prompt/URL/header/env/option secrets and raw receipt fields do not appear in stdout/stderr, zero turns and one original launch. Test `agent-tools.e2e.test.ts:262-348`, targeted PASS1/49 deselected (50 total), exit0 per worker transcript. It passed against existing source, without a mutant; no red-first or all-test mutation claim. Worker scoped lint/format pass. [verified: test source and actual CLI worker execution transcript]

At the pre-review checkpoint, all eight parts were checked for bounded source scope, with the two explicit limits above. Lint reported0 warnings/errors across83 files/177 rules; read-only format93 files and full typecheck exited0 after the CLI test. These checks predate the review corrections; current review and rerun status is recorded above. Provider/native/packaged smoke, metadata and installation permission remain release-only. [verified: prior final lint/format/typecheck logs and parent execution notifications]

## Goal, approved decisions and safety boundary

M wants each session to receive the optional plugin features its actual provider can use, then regain eligible features on a later supported open without changing preferences or stored plugin data. Two chats in the same directory must remain independent. Required caller permissions must never be weakened to achieve startup. [verified: authoritative plan, Context, Goals and Acceptance criteria]

M approved coordinated Paseo host/SDK plus Memorise, Contextualise, Computerise, Morphise and Datawise source work; six pinned worktrees this time; delegated disjoint plugin implementation; and finishing the approved parts without routine pauses. M selected copy-safe older-client options/features, accepting that legacy controls may omit temporary plugin overrides. Legacy adoption is explicit and reversible; required/mixed/unmarked policy stays strict. Unknown optional support remains limited rather than guessed. [verified: plan, Decision and Open questions; accepted ADR:5,23-25,55-63]

No production writes, installed-source edits, live-chat adoption, global configuration changes, running-service restart or paid/model turn are included. M subsequently authorized commits and pushes of the six feature branches and six draft PRs, with proposed prerelease notes only. Official npm/tag/store publication and installation are excluded. Local dependency staging and directory-plugin fixtures in an isolated daemon are not installation into M's running application. [verified: M's draft-PR authorization and integration harness]

## Worktrees and source/release separation

All paths below are under `/Users/monarchmaisuriya/Experiment/`. The branch/base column records M's pinned approval, not a fresh fetch or a claim that remote refs have not moved. [verified: plan, Open questions:2]

| Repository worktree               | Approved branch                      | Pinned base | Source package / declared plugin SDK | Staged plugin SDK    |
| --------------------------------- | ------------------------------------ | ----------- | ------------------------------------ | -------------------- |
| `paseo-adaptive-plugin-features`  | `feature/adaptive-provider-features` | `fd208b0a1` | Host/plugin SDK `0.16.2`             | Locally built source |
| `memorise-adaptive-features`      | `feature/adaptive-provider-features` | `e11266fb`  | `0.14.2` / `0.12.0`                  | `0.16.2`             |
| `contextualise-adaptive-features` | `feature/adaptive-provider-features` | `acd5e42d`  | `0.34.0` / `0.13.0`                  | `0.16.2`             |
| `computerise-adaptive-features`   | `feature/adaptive-provider-features` | `fde773e5`  | `0.7.0` / `0.13.0`                   | `0.16.2`             |
| `morphise-adaptive-features`      | `feature/adaptive-provider-features` | `0fb1566`   | `0.47.0` / `0.16.0-beta.1`           | `0.16.2`             |
| `datawise-adaptive-features`      | `feature/adaptive-provider-features` | `a15b7ada`  | `0.7.0` / `0.16.0-beta.2`            | `0.16.2`             |

Package and staged-SDK versions were read from each worktree's `package.json` and `node_modules/@getpaseo/plugin/package.json`. All five plugin manifests lack a `lint` script; no plugin lint result is invented. [verified: read-only package inspection in this task]

The staged `0.16.2` label is source-build metadata, not a released adaptive contract or proof that existing published requirements are correct. Assigning a real host/SDK release, aligning plugin dependency/manifest metadata, provider/platform smoke, and explicit installation authorization remain release gates. No absolute local dependency path is proposed as release metadata. [verified: plan, Compatibility and development SDK; accepted ADR:23,75]

## How to read the evidence

Raw log root: `/private/var/folders/vm/dcb_27hs4t50mktlkq73b7ww0000gn/T/opencode/`. Log names below are relative to that root. They are local temporary artifacts, not durable CI attachments; retain/copy them before temporary storage is removed.

`PASS` means the named run passed at its recorded checkpoint. It does not mean every acceptance criterion passed or that a run preceded by later source edits is final. `DID NOT RUN` below means no final run/result is attached at this snapshot; it does not erase an earlier run.

Execution evidence includes the parent's actual shell transcript/notifications as well as retained log text. Where a log omits an exit trailer, a parent-confirmed exit below cites that transcript rather than inferring success from silence.

The plan pins host tests/builds to Node `22.20.0`. The mutation manifest records Datawise on Node `24.22.1` and the other four probes on `22.20.0`; do not collapse that into a claim that every run used Node 22. Runner versions in the ten-owner log are Vitest `4.1.6` for server and `4.1.7` for SDK. [verified: plan, Verification commands; `adaptive-mutants-uz262w82/manifest.json`; `adaptive-final-owner-tests.log`]

## Integration through actual plugin subprocesses

Harness: `adaptive-actual-plugins.integration.ts`. Final result: `adaptive-final-actual-plugins.log`; final retained fixture: `adaptive-actual-plugins-Mo9TbR/acceptance.json`. Earlier `adaptive-actual-plugins.log` / fixture `2sj7f3` remains a historical checkpoint, superseded by the final run.

The harness copies contribution sources into a temporary fixture, supplies isolated roots/dependencies and a deterministic provider, then loads each through the real directory-plugin subprocess boundary. Five distinct plugin PIDs were recorded. Computerise uses an engine whose methods fail if invoked; provider turn methods also fail if invoked. No provider model or computer engine is exercised. [verified: harness:82-146,180-199,243-291; acceptance JSON]

| State / negative                           | Observed result                                                                               | Scope limit                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Supported                                  | 5 external servers, 23 optional exact grants, 39 native attached tools                        | Deterministic support facts, not actual provider negotiation                            |
| Limited                                    | 0 external servers/grants; native Datawise/history/Show remain                                | No screenshot/image/model parity claim                                                  |
| Restored                                   | Same server/grant and attached-tool names as first supported open                             | Does not prove every provider or retained-child transition                              |
| No exact approval                          | Same 5 servers, 0 optional grants                                                             | Confirms omission of grants, not a real provider prompt UI                              |
| Caller-occupied server names               | Caller maps/required policy preserved; no new grants or Computerise seat                      | Not automatic ownership/adoption                                                        |
| Duplicate tool / internal or foreign grant | Rejected before provider opening; provisional seats released                                  | Three explicit combined negatives                                                       |
| History open                               | No adaptive servers/grants/instructions/tools or new Computerise data                         | Deterministic archived-record fixture                                                   |
| Protected state                            | Settings and selected protected data byte-identical; saved intent excludes launch credentials | Only protected paths listed in harness:227-241; normal lifecycle/seat metadata excluded |
| Side effects                               | `engineCalls: []`, `turnAttempts: 0`                                                          | No real computer, model, database connection or production daemon used                  |

Literal result: `PASS: five real subprocesses; supported/limited/restored; ordinary prompts; caller bindings; collision/permission negatives; history; unchanged protected settings/data; zero engine calls and model turns`. [verified: `adaptive-actual-plugins.log:2`; harness:307-424; acceptance JSON]

VERIFY: ran `node --import tsx /private/var/folders/vm/dcb_27hs4t50mktlkq73b7ww0000gn/T/opencode/adaptive-actual-plugins.integration.ts` from host root with Node22.20.0: PASS (exit0; five real subprocesses, supported/limited/restored, ordinary prompts, caller bindings, collision/permission negatives, history, unchanged protected settings/data, zero engine/model calls). [verified: final integration log, Mo9TbR acceptance JSON and execution transcript]

## Latest lifecycle regression and transfer checks

The final cleanup regression exposed duplicate ownership of a rejected provider close: `AssertionError: expected 2 to be 1` in `an installation callback failure with rejected close keeps the live session and tools until confirmed close`. Red summary: `1 failed | 46 skipped (47)` at 21:23:45. [verified: `adaptive-install-close-red.log:9-35`]

The initial single-owner correction passed47 lifecycle cases. Final lifecycle49/manager318 and selected bootstrap3 supersede that checkpoint; worker/adoption validation subsequently passed74/25. Disposal failure caching/dispatch revocation and shutdown aggregation are included in bounded final verification. [verified: final copy/shutdown/boundary logs]

The lifecycle suite includes failed preparation, old-close timeout, confirmed-close/new-open failure, old native/HTTP dispatch isolation, installation failure, copy-safe reconnect, and preview/apply/reset cases. This is coverage of named cases, not every mixed-version envelope or retained-child contract. [verified: `packages/server/src/server/plugins/agent-tools.e2e.test.ts:74-594`]

Earlier exact transfer commands, from host `packages/server`, recorded in `adaptive-transfer-lifecycle-tests.log`:

- VERIFY: ran `npx vitest run src/server/plugins/agent-tools.e2e.test.ts --bail=1 --maxWorkers=1`: PASS (exit 0; Tests 47 passed (47); 21:20:53 checkpoint, before final cleanup).
- VERIFY: ran `npx vitest run src/server/agent/mcp-server.test.ts --bail=1 --maxWorkers=1`: PASS (exit 0; Tests 196 passed (196); 21:21:45 checkpoint, before final cleanup).
- VERIFY: ran `npx vitest run src/server/schedule/service.test.ts --bail=1 --maxWorkers=1`: PASS (exit 0; Tests 77 passed (77); 21:21:58 checkpoint, before final cleanup).

`adaptive-final-manager.log` now contains the latest 318-case pass at 21:44:40; earlier 316-case contents were overwritten. Historical counts above describe their checkpoints, not the current contents of that filename.

### Later template, voice and runtime checkpoints

Transcript: `adaptive-final-template-tests.log`, 21:27-21:28 IST. Commands below have literal exit-0 trailers. Run from the indicated host package directory; no full suite was run.

| Directory         | Literal verification command/result                                                                                                                       | What it establishes                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server` | VERIFY: ran `npx vitest run src/server/agent/agent-manager.test.ts --bail=1 --maxWorkers=1`: PASS (exit 0; Tests 318 passed (318))                        | Includes real adopted voice On/Off plus two ordinary reloads and byte-identical raw prompt/receipts; unsolicited launch-owned options excluded from durable/template intent |
| `packages/server` | VERIFY: ran `npx vitest run src/server/agent/mcp-server.test.ts --bail=1 --maxWorkers=1`: PASS (exit 0; Tests 196 passed (196))                           | Executes the exact stored schedule made from an adopted projected parent through `ScheduleService.runOnce`, preserving required policy and deriving fresh contributions     |
| `packages/client` | VERIFY: ran `npx vitest run src/connection.test.ts --bail=1 --maxWorkers=1`: PASS (exit 0; Tests 41 passed (41))                                          | Client boundary checkpoint                                                                                                                                                  |
| `packages/server` | VERIFY: ran `npx vitest run src/server/agent/providers/opencode/v2/owned-runtime.test.ts --bail=1 --maxWorkers=1`: PASS (exit 0; Tests 21 passed (21))    | Owned-runtime checkpoint                                                                                                                                                    |
| `packages/server` | VERIFY: ran `npx vitest run src/server/agent/providers/opencode/v2/external-runtime.test.ts --bail=1 --maxWorkers=1`: PASS (exit 0; Tests 10 passed (10)) | External-runtime checkpoint                                                                                                                                                 |
| `packages/server` | VERIFY: ran `npx vitest run src/server/agent/providers/opencode/runtime-client.test.ts --bail=1 --maxWorkers=1`: PASS (exit 0; Tests 32 passed (32))      | Runtime-client checkpoint                                                                                                                                                   |

The schedule proof is no longer split across unrelated fixtures. The owning MCP case creates the real template through the agent tool, runs that exact stored ID, asserts the launched required base and fresh optional contributions, then verifies original parent and new durable state. [verified: `packages/server/src/server/agent/mcp-server.test.ts:5064-5264`]

The voice proof compares serialized original config/receipts before and after On/Off and preserves the On overlay through two intervening ordinary reloads. The option-report case emits `options_changed` and checks effective, durable and template views independently. [verified: `packages/server/src/server/agent/agent-manager.test.ts:15796-15908,14595-14647`]

Earlier disposal checkpoint: `adaptive-final-disposal-tests.log` records all six commands below exit0. Final copy/lifecycle49/manager318 and runtime74 supersede affected rows. Bootstrap/worker teardown continues through provider/plugin cleanup errors before surfacing failure. [verified: final logs and source-tracing transcript]

| Exact command                                                                          | Literal result                                |
| -------------------------------------------------------------------------------------- | --------------------------------------------- |
| `npx vitest run src/server/plugins/lifecycle/handlers.test.ts --bail=1 --maxWorkers=1` | VERIFY: PASS (exit 0; Tests 37 passed (37))   |
| `npx vitest run src/server/plugins/runtime.posix.test.ts --bail=1 --maxWorkers=1`      | VERIFY: PASS (exit 0; Tests 72 passed (72))   |
| `npx vitest run src/server/plugins/agent-tools.e2e.test.ts --bail=1 --maxWorkers=1`    | VERIFY: PASS (exit 0; Tests 47 passed (47))   |
| `npx vitest run src/server/agent/agent-manager.test.ts --bail=1 --maxWorkers=1`        | VERIFY: PASS (exit 0; Tests 318 passed (318)) |
| `npx vitest run src/server/agent/mcp-server.test.ts --bail=1 --maxWorkers=1`           | VERIFY: PASS (exit 0; Tests 196 passed (196)) |
| `npx vitest run src/server/schedule/service.test.ts --bail=1 --maxWorkers=1`           | VERIFY: PASS (exit 0; Tests 77 passed (77))   |

Latest shutdown verification, from `packages/server`:

| Exact command                                                                                                                                                                                | Result and evidence                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `npx vitest run src/server/plugins/agent-tools.e2e.test.ts --bail=1 --maxWorkers=1`                                                                                                          | VERIFY: PASS (exit 0; Tests 49 passed (49)); `adaptive-final-shutdown-tests.log:5-11`                            |
| `npx vitest run src/server/bootstrap.smoke.test.ts --bail=1 --maxWorkers=1 -t 'stops new connections and agent registrations before closing agents\|shutdown closes Claude and its process'` | VERIFY: PASS (exit 0; Tests 3 passed, 21 skipped (24)); same log:16-22; filter selects three cases, not two      |
| `npx vitest run src/server/agent/agent-manager.test.ts --bail=1 --maxWorkers=1`                                                                                                              | VERIFY: PASS (exit 0 confirmed by parent shell; Tests 318 passed (318)); latest `adaptive-final-manager.log:5-8` |

The preceding manager run failed: `expected true to be false` after a zero-millisecond timer in the stale-start test (`adaptive-final-shutdown-tests.log:30-61`). Only the test synchronization changed: it now waits for actual resume entry and explicitly releases it through `resumeEntered`/`releaseResume` deferred promises. No production retry, sleep or behavior change was added. [verified: `agent-manager.test.ts:10154-10199`; parent test-only change confirmation]

VERIFY: ran `/Users/monarchmaisuriya/.nvm/versions/node/v22.20.0/bin/node /Users/monarchmaisuriya/Experiment/paseo-adaptive-plugin-features/packages/server/node_modules/vitest/vitest.mjs run src/server/agent/agent-manager.test.ts --bail=1 -t "a sender's start wait follows its prompt when the session is stale before the wait begins"` twenty independent times: PASS (20/20 exit 0; each `1 passed | 317 skipped (318)`). Exact per-run commands and logs: `adaptive-sensitivity.74pRRw/stale-start-repeat-evidence.log:1-42`. This checks the repaired synchronization rather than retrying a failing product test until green.

Boundary verification PASS: `plugin-boundary-mutants-qxu5t8qy/receipt-green.log` records25 adoption tests and `runtime-green.log`74 real-runtime tests, exit0. They prove256-receipt acceptance/257 rejection and16 KiB registration bounds. Both guard mutants failed intended assertions then source compared byte-exact (`cmp`). These2 contribute to final17 representative killed/restored mutants, none applied, not all-path coverage. Exact invocations/restoration are in the boundary worker transcript. [verified: named green/red logs and execution transcript]

Final host-root static/build ledger, `adaptive-final-build-static.log`:

- VERIFY: ran `npm run build:server`: PASS (exit0; server/CLI and SDK dependency build complete; log:78).
- VERIFY: ran `npm run build:app-deps`: PASS (exit0; highlight/protocol/client/plugin/audio build complete; log:129).
- VERIFY: ran `npm run typecheck`: PASS (exit0; all workspace checks complete; log:198).

Final copy ledger, from host `packages/server`, `adaptive-final-copy-tests.log`:

- VERIFY: ran `npx vitest run src/server/daemon-client.e2e.test.ts --bail=1 --maxWorkers=1 -t 'resume_agent copies adopted required intent|createAgentFromRecord projects adoption receipts|resume_agent treats unmatched handle config'`: PASS (exit0;3 passed,43 skipped (46)).
- VERIFY: ran `npx vitest run src/server/plugins/agent-tools.e2e.test.ts --bail=1 --maxWorkers=1`: PASS (exit0;49 passed).
- VERIFY: ran `npx vitest run src/server/agent/agent-manager.test.ts --bail=1 --maxWorkers=1`: PASS (exit0;318 passed).

The three cases are at `daemon-client.e2e.test.ts:1129,1243,1356`; they cover explicit new-ID overrides/source receipt exclusion, no-native reconstruction/archived history, and unmatched handle strictness. Mixed legacy/capable clients now feed a legacy wire snapshot into actual `createAgent` and assert durable options omit optional values (`agent-tools.e2e.test.ts:230-250`). A fixture comparison was corrected for JSON object-key order; no product workaround. [verified: source assertions, final copy log and execution transcript]

## Ten green owning-suite checkpoints

Raw transcript: `adaptive-final-owner-tests.log`. Every invocation below has an exit-0 trailer in that log. These ran at 20:42 and predate the final manager cleanup; names containing `final` in a filename do not override chronology.

Working directory `/Users/monarchmaisuriya/Experiment/paseo-adaptive-plugin-features/packages/server`:

- VERIFY: ran `npx vitest run src/server/agent/plugin-config-adoption.test.ts --bail=1`: PASS (exit 0; Tests 23 passed (23)).
- VERIFY: ran `npx vitest run src/server/authorization/index.test.ts --bail=1`: PASS (exit 0; Tests 8 passed (8)).
- VERIFY: ran `npx vitest run src/server/session/voice/voice-session.test.ts --bail=1`: PASS (exit 0; Tests 7 passed (7)).
- VERIFY: ran `npx vitest run src/server/session.voice-mcp-config.test.ts --bail=1`: PASS (exit 0; Tests 4 passed (4)).
- VERIFY: ran `npx vitest run src/server/plugins/internal-seam.e2e.test.ts --bail=1`: PASS (exit 0; Tests 2 passed (2)).
- VERIFY: ran `npx vitest run src/server/agent/provider-registry.test.ts --bail=1`: PASS (exit 0; Tests 52 passed (52)).
- VERIFY: ran `npx vitest run src/server/agent/plugin-provider.test.ts --bail=1`: PASS (exit 0; Tests 127 passed | 4 skipped (131)).

Working directory `/Users/monarchmaisuriya/Experiment/paseo-adaptive-plugin-features/packages/plugin`:

- VERIFY: ran `npx vitest run src/boundaries.test.ts --bail=1`: PASS (exit 0; Tests 103 passed (103)).
- VERIFY: ran `npx vitest run src/server/provider.test.ts --bail=1`: PASS (exit 0; Tests 8 passed (8)).
- VERIFY: ran `npx vitest run src/server/acp.test.ts --bail=1`: PASS (exit 0; Tests 58 passed (58)).

Total at this checkpoint: 392 passed, 4 skipped across 10 named files. Skips are disclosed, not counted as passes. [verified: transcript:5-110; sum of runner summaries]

## Earlier host checkpoints and failures

| Artifact                       | Observed result                                                                                                                                                                   | Current interpretation                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `adaptive-host-focused.log`    | Lifecycle handlers 36; launch merge 2; storage 20; projections 24; schedule store 8; client connection 34; outbound validation 14; CLI 2; app slash commands 7; runtime 71 passed | Earlier checkpoints only; adoption's earlier 4-test run superseded by 23 above                                                                   |
| Same log, attached-tool suite  | `Test timed out in 30000ms`, 1 failed                                                                                                                                             | Not hidden; later 41/42/47-case suite checkpoints passed, with latest lifecycle limits above                                                     |
| `adaptive-runtime-tests.log`   | 1 failed, 10 passed out of 71 at 18:49                                                                                                                                            | Earlier failure; later runtime checkpoint 71 passed                                                                                              |
| `adaptive-retained-checks.log` | OpenCode owned runtime 21, handlers 36, attached tools 41, CLI 2 passed with exit-0 trailers                                                                                      | Targeted retention checkpoints, not every retained-child condition                                                                               |
| `adaptive-host-typecheck.log`  | CLI `plugin-config.ts` command callback type errors; npm lifecycle exit code 2                                                                                                    | Historical failure; later full-host pass reported in `adaptive-final-typecheck.log`, before newest runtime disposal edit                         |
| `adaptive-format-check.log`    | `Format issues found in above 65 files`                                                                                                                                           | Failed read-only check; not green                                                                                                                |
| `adaptive-format.log`          | Scoped `format:files` completed successfully on 90 changed files under M's explicit scoped-only approval, reported by parent                                                      | Approved formatting exception; newer edits require final read-only check                                                                         |
| `adaptive-lint.log`            | Scoped lint invocation, no completion/exit summary in the retained log                                                                                                            | Do not claim final lint success from an empty tail                                                                                               |
| `adaptive-build-server.log`    | Server/CLI build reaches final TypeScript step without error text                                                                                                                 | Parent reports earlier build failed then passed; failed transcript/exit and final-source rebuild still need attaching                            |
| `adaptive-build-app-deps.log`  | Local protocol/client/plugin/app dependencies build transcript reaches final audio TypeScript step                                                                                | Earlier staged SDK checkpoint, not release metadata or a final-source build                                                                      |
| `adaptive-final-typecheck.log` | Full-workspace typecheck PASS, exit 0 confirmed by actual parent shell notification                                                                                               | Checkpoint precedes newest runtime disposal source change, so final repeat needed                                                                |
| `adaptive-final-lint.log`      | PASS, exit 0 confirmed by parent shell; `Found 0 warnings and 0 errors`, 82 files, 177 rules                                                                                      | Replaced earlier failing log; prior shadow/complexity findings fixed without disabling rules; later edits still need final changed-path coverage |

These are observations of existing transcripts, not new failures produced by the record-keeping task. Prior build/static failures must remain visible until explicitly linked to a successful post-repair result. [verified: named logs; delegated brief for earlier failed-then-passed build]

Scoped lint success follows factoring internal MCP launch binding and excluding undefined launch contributions at their manager owners (`bindInternalMcpLaunch`, `definedLaunchContributions`). Exact path arguments are the expanded command in `adaptive-final-lint.log:3`; no lint rule was disabled. [verified: manager:6859,6983-6994,7170; lint log:3-6; parent shell result]

Host typecheck checkpoint: VERIFY: ran `npm run typecheck` from the host root: PASS (exit 0; all workspace checks completed). This pass predates the newest runtime disposal source change and is not the final-source repeat. [verified: parent actual shell notification; `adaptive-final-typecheck.log`]

## Plugin owning-suite checkpoints

Each command below ran from `/Users/monarchmaisuriya/Experiment/<plugin>-adaptive-features`. These are source checkpoints, not a promise that every combined plan condition has been mapped. Raw transcripts retain diagnostics, including expected negative-path logging.

### Latest all-five-plugin typechecks

`adaptive-final-plugin-typechecks.log` contains an exit-0 trailer for every plugin after fresh protocol declaration staging. Contextualise's earlier source type error was fixed; its successful result is now attached here. Morphise's theme fix preceded its latest test run; the later `followedBySuffix` failure was stale staged protocol declarations, resolved by restaging without another source patch. These latest passes supersede earlier failed typecheck checkpoints. [verified: final typecheck log:2-30; Morphise log:740-749; parent source/staging explanation]

| Owning worktree                   | Exact verification                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| `memorise-adaptive-features`      | VERIFY: ran `npm run typecheck`: PASS (exit 0; client and server TypeScript checks completed) |
| `contextualise-adaptive-features` | VERIFY: ran `npm run typecheck`: PASS (exit 0; client and server TypeScript checks completed) |
| `computerise-adaptive-features`   | VERIFY: ran `npm run typecheck`: PASS (exit 0; client and server TypeScript checks completed) |
| `morphise-adaptive-features`      | VERIFY: ran `npm run typecheck`: PASS (exit 0; TypeScript check completed)                    |
| `datawise-adaptive-features`      | VERIFY: ran `npm run typecheck`: PASS (exit 0; client and server TypeScript checks completed) |

### Memorise

Transcript: `adaptive-memorise-verification.log`.

- VERIFY: ran `npm test -- server/plugin.test.ts --bail=1`: PASS (exit 0; Tests 69 passed (69)).
- VERIFY: ran `npm test -- server/index-prompt.test.ts --bail=1`: PASS (exit 0; Tests 18 passed (18)).
- VERIFY: ran `npm test -- server/capture.test.ts --bail=1`: PASS (exit 0; Tests 55 passed (55)).
- VERIFY: ran `npm test -- server/mcp.test.ts --bail=1`: PASS (exit 0; Tests 26 passed (26)).
- VERIFY: ran `npm test -- server/receipts.test.ts --bail=1`: PASS (exit 0; Tests 2 passed (2)).
- VERIFY: ran `npm run typecheck`: PASS (exit 0; client and server TypeScript checks completed).

### Contextualise

Transcript: `adaptive-contextualise-verification.log`.

- VERIFY: ran `npm test -- server/knowledge/plugin.test.ts --bail=1`: PASS (exit 0; Tests 108 passed (108)).
- VERIFY: ran `npm test -- server/knowledge/mcp.test.ts --bail=1`: PASS (exit 0; Tests 15 passed (15)).
- VERIFY: ran `npm test -- server/knowledge/overview.test.ts --bail=1`: PASS (exit 0; Tests 6 passed (6)).
- VERIFY: ran `npm test -- server/knowledge/section.test.ts --bail=1`: PASS (exit 0; Tests 12 passed (12)).
- VERIFY: ran `npm test -- server/knowledge/links.test.ts --bail=1`: PASS (exit 0; Tests 15 passed (15)).
- VERIFY: ran `npm test -- server/plugin.test.ts --bail=1`: PASS (exit 0; Tests 3 passed (3)).
- VERIFY: ran `npm test -- server/chat-history.test.ts --bail=1`: PASS (exit 0; Tests 14 passed (14)).
- VERIFY: ran `npm test -- server/workspace-chats.test.ts --bail=1`: PASS (exit 0; Tests 14 passed (14)).
- VERIFY: ran `npm run typecheck`: FAIL at this earlier checkpoint (exit 2; test MCP-header casts/unknown authority plus generic handler wire-input type error at `server/knowledge/plugin.ts(214,12)`). Superseded by the all-five-plugin exit-0 run above; do not treat this historical failure as current.

### Computerise

Transcript: `adaptive-computerise-verification.log`.

- VERIFY: ran `npm test -- server/identity.test.ts --bail=1`: PASS (exit 0; Tests 13 passed (13)).
- VERIFY: ran `npm test -- server/plugin.test.ts --bail=1`: PASS (exit 0; Tests 64 passed (64)).
- VERIFY: ran `npm test -- client/mode-header.test.ts --bail=1`: PASS (exit 0; Tests 14 passed (14)).
- VERIFY: ran `npm run typecheck`: PASS (exit 0; client and server TypeScript checks completed).

The plugin suite names cases for 100 disposed replacement attempts, 100 fresh provider-open failures, parent Off initialization, per-agent seats and retained modes. These are deterministic plugin fixtures, complemented by the actual-worker integration, not real computer-engine calls. [verified: `computerise-adaptive-features/server/plugin.test.ts:284-332,443-470`]

### Morphise

Earlier transcript: `adaptive-morphise-verification.log`; page-registration 32 and task-list 16 below are superseded by latest 35/19 runs. Other owning-suite passes remain their recorded checkpoints. [verified: both Morphise transcripts]

- VERIFY: ran `npm test -- server/polish/pages.register.test.ts --bail=1`: PASS (exit 0; Tests 32 passed (32)).
- VERIFY: ran `npm test -- server/polish/pages/html-tool.test.ts --bail=1`: PASS (exit 0; Tests 35 passed (35)).
- VERIFY: ran `npm test -- server/polish/pages/agent-folders.test.ts --bail=1`: PASS (exit 0; Tests 10 passed (10)).
- VERIFY: ran `npm test -- server/show.test.ts --bail=1`: PASS (exit 0; Tests 35 passed (35)).
- VERIFY: ran `npm test -- server/plan-tools.test.ts --bail=1`: PASS (exit 0; Tests 16 passed (16)).
- VERIFY: ran `npm test -- server/titles.test.ts --bail=1`: PASS (exit 0; Tests 7 passed (7)).
- VERIFY: ran `npm test -- server/polish/pages/guide.test.ts --bail=1`: PASS (exit 0; Tests 2 passed (2)).
- VERIFY: ran `npm test -- shared/polish/page.test.ts --bail=1`: PASS (exit 0; Tests 35 passed (35)).
- VERIFY: ran `npm run typecheck`: FAIL at this earlier checkpoint (exit 2; four `Required<PluginThemeColors>` objects missing newly required theme keys in `shared/polish/theme.ts`). Superseded by the all-five-plugin exit-0 run above.

Latest changed-suite checkpoint in `adaptive-final-morphise.log`, from the Morphise worktree:

- VERIFY: ran `npm test -- server/polish/pages.register.test.ts --bail=1 --maxWorkers=1 --minWorkers=1`: PASS (exit 0; Tests 35 passed (35)).
- VERIFY: ran `npm test -- server/plan-tools.test.ts --bail=1 --maxWorkers=1 --minWorkers=1`: PASS (exit 0; Tests 19 passed (19)).
- VERIFY: ran `npm run typecheck`: FAIL at the intervening staging checkpoint (exit 2; staged protocol selector type lacks `followedBySuffix`). The separate all-plugin typecheck log above records the subsequent PASS after declaration restaging, not a source patch for this error.

The new 100-cycle page-registration case calls the real local HTTP endpoint: fresh/retained tokens return 200, disposed candidates return 403, the installed original survives candidate disposal, its final disposal returns 403, and an existing legacy token remains 200. Every cycle asserts the persistent token rows and file bytes remain at baseline. The fixture exercises plugin credentials, not a live provider or model. [verified: `morphise-adaptive-features/server/polish/pages.register.test.ts:184-248`; final Morphise log:680-688]

### Datawise

Fresh transcript: `adaptive-final-datawise.log`, Node `24.22.1`, from the Datawise worktree:

- VERIFY: ran `npm test -- server/agent-hook.test.ts --bail=1 --maxWorkers=1`: PASS (exit 0; Tests 14 passed (14)).
- VERIFY: ran `npm test -- server/agent-tools.test.ts --bail=1 --maxWorkers=1`: PASS (exit 0; Tests 40 passed (40)).

The safety run retains temporary activity-store teardown warnings, including `ENOENT: no such file or directory, rename '.../agent-activity.json.<uuid>.tmp' -> '.../agent-activity.json'` at log:25 and later missing-directory warnings. All 54 assertions passed; this is not a warning-free run. Parent verified the relevant baseline source is unchanged; a separate baseline runtime reproduction is unverified. No safety check was disabled or source workaround applied. [verified: final Datawise log:8-16,24-75; parent baseline source comparison]

Node 24.22.1 was deliberate: Datawise's README:76 records SQLite `DatabaseSync.setAuthorizer` (added in Node 24.10.0), linking version-matched official [Node 24.22.1 documentation](https://github.com/nodejs/node/blob/v24.22.1/doc/api/sqlite.md#databasesetauthorizercallback). Parent checked that API source/docs; this is the SQLite safety runtime, not an unexplained switch from the host's Node 22 pin. Latest Datawise typecheck also passes in the all-plugin log. [verified: README:76; parent official-source check; final Datawise/typecheck logs]

## Browser flows and actual Computerise panel renders

Working directory: `/Users/monarchmaisuriya/Experiment/paseo-adaptive-plugin-features` (host root). Raw transcript: `adaptive-browser-tests.log`.

VERIFY: ran `npm run test:e2e --workspace=@getpaseo/app -- --project=browser e2e/browser/assistant-fork-menu.spec.ts e2e/browser/client-slash-commands.spec.ts --workers=1 --max-failures=1`: PASS (exit 0; 13 passed (1.7m); isolated daemon/Metro stop lines present). [verified: parent actual execution transcript; browser log]

The earlier13-case result is supplemented by the latest combined run in `adaptive-final-browser.log` / `computerise-header.Vpb855/playwright-report-combined.json`:13 app cases PASS including the actual hello assertion. That combined invocation was not wholly green: its extra header case failed before mount because a temporary config override wrote before daemon-home creation. Removing that temporary override allowed the header-only pass below; no product-source workaround. [verified: parent execution transcript; header README:3-9 and preserved combined stats]

Actual header verification: `computerise-header.Vpb855/header-verification.json` reports PASS, limited/prepared/available/saved states,8 screenshots, zero page/console/cleanup errors, source copy verified,1 expected/0 unexpected/0 flaky. `header-evidence.json` records the real host label/menu and Off updating both mock chat modes in every state, with no forbidden engine calls. VERIFY: header-only execution PASS (exit0;1 passed (18.8s)), exact `env -u` invocation retained in the executing worker transcript and `newadaptive-header-only.log`. Temporary capture locator correction targeted the actual Off row; assertions were not weakened. Source visual gate satisfied, not native/engine/provider proof. [verified: named JSON/logs; README:3-9,37-46,76-83; parent execution transcript]

Actual panel render artifact: `computerise-render.c1JMyR/evidence.json`; command recorded inside it: `node /private/var/folders/vm/dcb_27hs4t50mktlkq73b7ww0000gn/T/opencode/computerise-render.c1JMyR/render.cjs`. The artifact reports `status: PASS`; numeric exit status is not recorded. Versions: Playwright `1.58.2`, Chromium `145.0.7632.6`, React `19.2.3`, React Native Web `0.21.2`. [verified: render JSON:10-18,1113-1115]

| Actual ComputerPanel state | 1100 px | 390 px | Recorded interaction assertions                             |
| -------------------------- | ------- | ------ | ----------------------------------------------------------- |
| `available`                | PASS    | PASS   | Explanation visible; Off, Stop/Resume, Refresh usable       |
| `unavailable`              | PASS    | PASS   | Same controls remain usable with tools unavailable          |
| `prepared`                 | PASS    | PASS   | Does not claim confirmed host admission                     |
| `saved`                    | PASS    | PASS   | Saved configuration is identified as not yet fully adaptive |
| Mixed `limited` workspace  | PASS    | PASS   | Unavailable chat retains usable mode controls               |
| `saved-error`              | PASS    | PASS   | Invalid/unverified saved endpoint guidance visible          |

The artifact contains 12 screenshot paths/text snapshots, no page exceptions/network requests and no Computerise server-module bundle inputs. Named note: 12 console warnings, `Each child in a list should have a unique "key" prop.`, are baseline existing panel behavior per parent, outside this change; no cleanup was performed or clean-console claim made. These are panel warnings, not host-header rendering evidence. [verified: render JSON:23-1053,1055-1112; parent baseline/scope update]

Limits explicitly recorded by the harness: not host-header rendering, not engine availability evidence, synthetic health/theme, browser-page captures only and no computer screenshot RPC. A 390 px browser render is not iOS or Android testing. A mode-header unit test is not a visible host-header render. Existing approval/enforcement behavior is not proved by empty synthetic pending requests. [verified: render JSON:2-8 and recorded RPC calls]

## Mutation probes: prove restoration assertions can fail

Artifacts: `adaptive-mutants-uz262w82/{manifest.json,summary.json,cmp-evidence.txt}` and one `<plugin>-mutant.log` per plugin. These are deliberate temporary defects, not unplanned product failures.

Each probe bypassed the support/delivery omission relevant to its restoration test. All five were killed by an assertion failure, then the source and test files compared byte-identical with saved backups (`cmp ... => exit 0`). This verifies restoration of the probe snapshot, not that no legitimate source edits happened later. [verified: mutation summary and all 18 compare lines]

| Probe         | Expected red observation                                            | Result                                                                        |
| ------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Datawise      | Extra tools remained in limited opening instead of only caller tool | Exit 1; 1 failed / 13 skipped; `server/agent-hook.test.ts:74:29`              |
| Memorise      | Limited MCP map was nonempty                                        | Exit 1; 1 failed / 68 skipped; `server/plugin.test.ts:193:40`                 |
| Computerise   | Limited MCP map was nonempty                                        | Exit 1; 1 failed / 63 skipped; `server/plugin.test.ts:264:40`                 |
| Contextualise | Limited MCP map was nonempty                                        | Exit 1; 1 failed / 107 skipped; `server/knowledge/plugin.test.ts:187:32`      |
| Morphise      | Limited HTML contribution existed                                   | Exit 1; 1 failed / 33 skipped; `server/polish/pages.register.test.ts:174:140` |

Exact commands copied from the mutation summary, run in each owning plugin worktree (all expected to fail while mutated):

- VERIFY: ran `/Users/monarchmaisuriya/.nvm/versions/node/v24.22.1/bin/node node_modules/vitest/vitest.mjs run server/agent-hook.test.ts -t 'restores identical definitions after a limited open without changing stored data' --bail=1 --maxWorkers=1 --no-file-parallelism --no-color`: FAIL as intended (exit 1; Tests 1 failed | 13 skipped (14); Datawise mutant killed).
- VERIFY: ran `/Users/monarchmaisuriya/.nvm/versions/node/v22.20.0/bin/node node_modules/vitest/vitest.mjs run server/plugin.test.ts -t 'restores supported features after a limited open without changing saved preferences or memories' --bail=1 --maxWorkers=1 --no-file-parallelism --no-color`: FAIL as intended (exit 1; Tests 1 failed | 68 skipped (69); Memorise mutant killed).
- VERIFY: ran `/Users/monarchmaisuriya/.nvm/versions/node/v22.20.0/bin/node node_modules/vitest/vitest.mjs run server/plugin.test.ts -t 'restores HTTP tools without changing settings or the retained mode' --bail=1 --maxWorkers=1 --no-file-parallelism --no-color`: FAIL as intended (exit 1; Tests 1 failed | 63 skipped (64); Computerise mutant killed).
- VERIFY: ran `/Users/monarchmaisuriya/.nvm/versions/node/v22.20.0/bin/node node_modules/vitest/vitest.mjs run server/knowledge/plugin.test.ts -t 'derives independent contributions again after a limited opening without saving a create hook' --bail=1 --maxWorkers=1 --no-file-parallelism --no-color`: FAIL as intended (exit 1; Tests 1 failed | 107 skipped (108); Contextualise mutant killed).
- VERIFY: ran `/Users/monarchmaisuriya/.nvm/versions/node/v22.20.0/bin/node node_modules/vitest/vitest.mjs run server/polish/pages.register.test.ts -t 'restores HTML after a limited open without changing preferences' --bail=1 --maxWorkers=1 --no-file-parallelism --no-color`: FAIL as intended (exit 1; Tests 1 failed | 33 skipped (34); Morphise mutant killed).

Restoring files is separately proved by the literal `cmp` commands/results in `cmp-evidence.txt`. The mutation summary alone does not contain a complete post-restoration green rerun for every plugin; attach that final evidence rather than claim red-to-green from a red probe alone.

### Snapshot projection sensitivity

Parent reports the expanded snapshot suite green with 62 cases. Three sensitivity mutations were then killed and the source/test backups compared equal, with exact commands/results retained under `agent-projection-red-probes-gsdy6f4x/`. The green run's exact command/exit is not in that directory; attach the parent transcript for a final `VERIFY:` line. [verified: parent factual update; three red and restoration logs]

| Mutation                                     | Literal recorded command from `packages/server`                                                                       | Red / restoration evidence                                                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Status-created envelope skips projection     | `npx vitest run src/server/agent/agent-projections.test.ts --bail=1 -t 'projects schema-owned.*status agent_created'` | `status-mutant-corrected.log`: exit 1, 1 failed / 61 skipped; actual `view: original`, expected `projected`; restoration `cmp` exit 0 |
| Stored receipt projection omitted            | `npx vitest run src/server/agent/agent-projections.test.ts --bail=1 -t 'projects stored adoption options'`            | Exit 1, 1 failed / 60 skipped; actual `fast_mode: true`, expected `false`; restoration `cmp` exit 0                                   |
| Generic persistence launch environment leaks | `npx vitest run src/server/agent/agent-projections.test.ts --bail=1 -t 'scrubs generic launch configuration'`         | Exit 1, 1 failed / 60 skipped; persistence-handle assertion failed; source and test restoration `cmp` exit 0                          |

The initial `status-mutant.log` selected no tests (`62 skipped`); it is not a killed mutant. The corrected command above selected and failed the intended assertion. Three killed mutants means the corrected status, stored-receipt and persistence-environment probes only. [verified: initial/corrected status logs and three restoration logs]

Three probes in `adaptive-sensitivity.74pRRw/` fail template/voice/options assertions and restore byte-exact. Four further strict-recipe guard mutants were killed/restored with four filtered green checks in the strict-guard execution transcript. Final total17 representative mutants (5 plugin +3 snapshot +3 consumer +2 bounds +4 strict recipe), not all-path coverage; none remains applied. [verified: mutation logs and parent strict-guard/restore transcript]

## Consolidated deterministic acceptance

This replaces the earlier provisional gap matrix. PASS is bounded to the named owning assertions and final fixture, never every conceivable provider/path.

| Behavior                                                                           | Result / proving evidence                                                                                                                              |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Per-open supported/limited/restored, native without HTTP, unchanged protected data | PASS; final five-worker integration Mo9TbR and plugin suites                                                                                           |
| Ordinary prompts, strict caller/mixed policies, occupied names and Off             | PASS; integration negatives, adoption25 and mapped plugin cases                                                                                        |
| Cold/concurrent support and actual provider identity                               | PASS; provider/ACP/registry and OpenCode owning suites; no model discovery                                                                             |
| Staged native/HTTP dispatch, failed-open/uncertain-close cleanup and shutdown      | PASS; final lifecycle49/manager318, runtime74, selected bootstrap3                                                                                     |
| Secret-free preview, exact reversible adoption, bounds/provenance rejection        | PASS adoption25/runtime74, actual-worker round trip and actual built-CLI redaction characterization1; no mutation/red-first claim for characterization |
| Persistence/reconstruction/import/history and new-ID copy                          | PASS; final selected daemon-client3, manager318, storage/projection suites and final history fixture                                                   |
| Child/schedule required intent and voice On/Off                                    | PASS; exact stored schedule MCP196/service77; manager voice/option-report tests and sensitivity probes                                                 |
| Legacy/capable snapshots, reconnect and old wire seed into new saved intent        | PASS; final lifecycle49 mixed-client case, snapshot62, client41                                                                                        |
| App fork/clear, actual hello and Computerise UI                                    | PASS; app13, actual host header1/four states and panel12; routed app-runtime exercise source-only                                                      |
| Seat/token boundedness, original/legacy authority retained                         | PASS; Computerise and Morphise100-cycle tests, real local HTTP200/403 and byte-identical persistent rows                                               |

These acceptance rows and the pre-review gate table are historical passing checkpoints, not closure of the newly reproduced transitions. Current correction/review gates are authoritative in the provisional section above. Full local host monorepo tests were not run, per repository rule. Release-only gates remain below.

## Platform/provider limits

| Platform / integration                             | Tested here                                                                                  | Limit                                                                                  |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| macOS host / local Node subprocesses               | Named deterministic suites and five real plugin workers                                      | No live provider/model or production daemon                                            |
| Browser web                                        | Latest13 app passes/hello;12 panel state/width renders;actual host header4 states/8 captures | Synthetic availability/RPC fixtures; no computer engine, native or live-provider proof |
| Electron macOS                                     | Not established                                                                              | No packaged Electron/full host-header availability smoke                               |
| iOS                                                | Not run                                                                                      | Narrow browser viewport is not native evidence                                         |
| Android                                            | Not run                                                                                      | No emulator/device evidence                                                            |
| Windows desktop/daemon                             | Not run                                                                                      | No lifecycle/process/platform evidence                                                 |
| Linux desktop/daemon/Docker                        | Not run                                                                                      | No runtime/packaging evidence                                                          |
| Real Claude/Codex/OpenCode/Pi/ACP/plugin providers | Not run as final manual QA                                                                   | Deterministic provider fixtures establish boundaries, not live approvals/image results |

Codex optional exact preapproval remains `unknown` in the source resolver. No local real-Codex additive-approval proof is claimed; ordinary prompts are the conservative outcome. [verified: `packages/server/src/server/agent/providers/codex-app-server-agent.ts:7823-7828`; plan, Codex source-check boundary]

## Handoff

Review corrections remain IN PROGRESS: targeted host/four-plugin regressions, updated composed integration, host build/full typecheck, scoped lint and downstream consumer reruns pass. Read-only formatting and second fresh-review verdict remain pending; no ship claim. Earlier source checks and all17 restored representative mutants remain checkpoint evidence, not a second-review verdict. Routed opt-in stays source-only and Codex optional approval unknown. No install/restart/publication/commit/push.

Parent owns final verification, review responses and scoped formatting of these two Markdown records. Retain all six uncommitted worktrees and the authoritative plan. Source-only acceptance check remains due2026-11-26; native/real-provider/version/install release gates stay separate and paused. This worker changed only the QA evidence and authoritative plan; no heavy command was run.
