# Reduced runtime repairs

Implemented only FP4 helper-runtime containment, FP17 abandoned-summary-request cleanup, and FP11 config subscription. No chapters retention, lifecycle controller, live summary toggle, protocol/schema edits, commits, or ledger edits.

## Changes

- `packages/server/src/server/agent/tool-call-summaries/generation.ts`: exclude candidates whose runtime lacks helper restrictions before availability/selection/session creation. Reuse existing provider options and selection order; retain configured/default/source-provider candidates among supported runtimes. Record skipped runtime in existing activity attempts. Resolve options once and carry them on the selected candidate. Local `flatMap` keeps the existing helper under complexity lint without adding a helper runner/abstraction.
- `packages/server/src/server/agent/tool-call-summaries/service.ts`: finish request IDs when dropped retries lose their last owner through source disappearance/already-summarized filtering or overflow. `finishActivity` checks existing pending queues so split retries cannot finish early. Existing active batch now holds its request ID, protecting it when overflow/invalidation/disposal removes pending siblings. Canceling queued activity removes that queue before finalization; active work finalizes after cancellation settles. No separate registry/state machine.
- `packages/server/src/server/sleep-inhibitor/index.ts`: require the existing daemon config onChange port, subscribe evaluate, unsubscribe on dispose.

## Tests and evidence

All commands below ran from `packages/server`, except npm scripts at repository root. No broad suites or live daemon restarts.

1. `npx vitest run src/server/sleep-inhibitor/index.test.ts --bail=1`
   - Red: mid-run config change without a repeated agent event expected release count 1, received 0.
   - Green: 12/12, including off/on state notifications, disposal unsubscription, existing idle debounce/internal-agent/unsupported-backend behavior.
2. `npx vitest run src/server/agent/tool-call-summaries/integration.test.ts --bail=1`
   - Red: Copilot helper attempted session creation instead of rejecting unavailable constrained candidates.
   - Green final: 12/12. Copilot/Pi/custom unknown runtimes create no helper; unsupported Pi followed by custom Claude/Codex/OpenCode runtime reaches only constrained provider with exact options. Real manager uses real option schemas, existing fake provider client and typed createSession spy. Existing helper reuse/rotation/invalidation/persistence tests remain green.
   - Initial new custom-runtime test fixture lacked its option validator; corrected fixture to use real runtime option schemas.
3. `npx vitest run src/server/agent/tool-call-summaries/service.test.ts --bail=1`
   - Red: failed batch retried, all sources disappear, activity remained queued instead of canceled.
   - Green final: 12/12. Tests also cover partial overflow retaining request, last overflow canceling it, retry inputs growing to split a request across batches, missing one member with surviving split work, and pending siblings overflowing while another member is active. Existing scheduling/timeout/cancellation tests remain green.
4. `npm run format:files --` all six edited files: passed. Script uses repository formatter.
5. `npm run lint --` all six edited files: passed 0 warnings/errors. Initial helper complexity 22 was corrected by preparing constrained candidates in a local flatMap before existing availability loop; final integration tests rerun afterward.
6. `npm run typecheck --workspace=@getpaseo/server`: passed final (exit 0).

## Actual size

Production: +58 / -10 (net +48) across 3 files.
Tests: +261 / -7 (net +254) across 3 existing test files.
Production within proposed 45–110 guideline; tests ~21 lines above 240 guideline, for exact supported runtime matrix and split/active retry ownership evidence. No test-only production port added.

Per file added/deleted:

- generation.ts 18/4
- service.ts 34/5
- sleep-inhibitor/index.ts 6/1
- integration.test.ts 120/0
- service.test.ts 110/0
- sleep-inhibitor/index.test.ts 31/7

## Limits / follow-up verification

Fresh closure verifier still required by orchestrator. Tests prove options passed at real manager/provider creation boundary using deterministic existing adapters, not live vendor sandbox enforcement. Sleep backend test proves synchronous config notification to acquisition/release port, not actual OS sleep. New queue tests directly use real summarizer and background recorder, not UI. Shared-request merging and explicit invalidation/disposal inspected; existing tests cover lifecycle cancellation, but new focused tests prioritize demonstrated drop/split paths.

## Bounded repair after fresh verification

Verifier found a split-retry fatal cleanup gap: SummaryCancellationError entered pause after initial finishActivity skipped the request because pending siblings remained. Pause deleted siblings but protected the active request, leaving it queued after task settlement.

Added exact real-summarizer/recorder regression: initial 4-call batch fails; inputs grow to force 3+1 split; first retry refuses cancellation; all generation pauses; request must fail rather than remain queued and no later work runs. `/tmp/fp17-fatal-red.log`: expected failed, received queued. `/tmp/fp17-fatal-green.log`: 13/13 pass.

Correction: fatal branch calls pause first, then finishActivity after siblings have been dropped. Ordinary failures retain finish-before-retry order. Net +1 production line; no new state or lifecycle. Service is now +36/-6 and service tests +136/-0. Combined production +60/-11 (net +49); tests +287/-7 (net +280). Exact service test rerun only; unrelated green files not rerun. npm format:files on both files passed, targeted lint 0 warnings/errors, server typecheck final exit0. Requested fresh recheck from /root/fix_layout_history.
