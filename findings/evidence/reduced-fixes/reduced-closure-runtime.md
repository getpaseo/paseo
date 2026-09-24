# Fresh runtime verification — reduced fixes

Candidate: shared uncommitted runtime patch over 23cb8e83c; inspected 2026-09-22. Read-only verifier did not implement this batch and did not rerun the already-green files. Evidence source: /tmp/reduced-runtime-result.md, inspected production/test diffs and neighboring lifecycle paths. Status below is verifier assessment; root owns ledger.

## FP4 / CR1-3 — unsupported summary helper runtimes

Verdict: PASS, bounded to capability restrictions passed at provider session creation.

Generation now resolves each candidate's actual runtime via AgentManager.getProviderRuntimeId, excludes candidates with no helperProviderOptions before availability/session creation, and carries the exact selected options into createAgent. This covers configured candidates, defaults and source selection because all originate from the same resolved providers list. Supported derived Claude/Codex/OpenCode custom providers remain reachable. Existing helper reuse is safe within a running fixed process because every helper enters the map through the constrained creation path; retry rotation repeats the same filter. Existing no-Paseo-tools, empty MCP servers, reactive permission denial/cancellation remain unchanged.

Read integration additions: unavailable Copilot/Pi/unknown custom sessions are never created; unsupported Pi falls through to derived runtime, real manager validation receives exact supported option schemas, and skipped attempt is observable. Fixer reported red on unrestricted creation and final integration 12/12 green; no live provider enforcement test ran. Maintenance is proportionate: +18/-4 lines, one local candidate filter, no runner consolidation, source restrictions or extra caller obligations.

## FP11 / CR1-6 — live sleep-setting changes

Verdict: PASS, bounded to notification-to-backend behavior.

Sleep inhibitor subscribes its existing evaluate function to actual daemonConfigStore.onChange and unsubscribes on disposal. Inspected real config store: onChange fires after committed config updates, get() reads current config. Bootstrap passes the real daemon config store. Existing evaluate releases immediately when disabled, cancels pending debounce, reacquires if enabled with busy agents; normal idle debounce and internal-agent exclusion remain unchanged. Disposed flag plus unsubscribing prevent reacquisition after teardown.

Read modified fake-port test: off/on is driven by config notification without repeating an agent event; state transitions, release/reacquire counts and post-disposal no reacquisition asserted. Fixer reported red release count 0 instead of 1, final 12/12 green. Actual OS sleep not tested. Maintenance matches local correction: +6/-1 lines, existing notification ownership, no new lifecycle state.

## FP17 queue portion / CR1-12 — finish abandoned requests after last member

Initial verdict: FAIL — one bounded cancellation path remained stranded. Recheck below supersedes this verdict.

The changes correctly address source disappearance/already-summarized drops, oldest-item overflow, pending split retries and active siblings: dropped IDs are reconciled after queue updates, finishActivity checks remaining pending queues, active requestId guards prevent ending a request while its generator is still running. Read fixer-reported final 12/12 scheduling tests and added assertions using real background recorder for missing sources, partial/final overflow and split success. +34/-5 production lines is proportionate reuse of existing queue/active ownership.

Failure found statically through real paths: a failed request retries, larger source material splits that retry into current batch plus queued sibling with the same requestId, and current generator throws SummaryCancellationError (real generation.run emits it when helper cancellation is refused). runNext catch first invokes finishActivity, which returns because queued sibling exists. It then calls pause(error). pause calls cancelQueuedActivity, which deletes the queue but deliberately skips active.requestId. Finally runNext clears active. No terminal write remains, so the request stays queued/running forever although service is paused and no queue member survives. Existing fatal-cancellation test asserts scheduling only and has no manager/background request; new split tests cover normal completion only.

Required repair: finish the current request after fatal pause removes its final queued siblings, without weakening active-member protection for normal invalidation/overflow. Add focused real-recorder regression combining split retry with SummaryCancellationError; red then green. Original fixer/root notified. This report does not authorize broader lifecycle machinery.

## Evidence limits

No live vendor session, actual OS sleep, or UI verification. Reported final targeted lint and server typecheck passed; verifier inspected tests and relied on existing execution report, per instruction not to rerun exact green files. Raw runtime red/green terminal logs were not separately present in /tmp; execution evidence comes from fixer report. Queue fatal split finding is static, not yet reproduced by verifier.

## Bounded FP17 repair recheck

Final verdict: PASS for the agreed queue/request ownership guarantee.

Inspected current catch: SummaryCancellationError now calls pause(error) first, removing queued siblings without prematurely finishing current active request; it then calls finishActivity(requestId,error,aborted), which sees no queued owners and records failed/canceled before finally clears active. Ordinary success/failure, timeout retry, invalidation and overflow paths retain their prior ordering/protection. No state or lifecycle owner added; repair is net one production line.

Read actual /tmp/fp17-fatal-red.log: the new split retry plus refused-cancellation test received queued instead of failed. Read /tmp/fp17-fatal-green.log: same file final 13/13 passed. New test confirms active batch has three of four retried members, terminal request status becomes failed, and no further generation occurs. Earlier split success/overflow survival tests remain in that green file. No test rerun by verifier. Original limitation remains: provider cancellation enforcement itself is not live-tested, and refusal deliberately pauses the summarizer.

FP4 and FP11 PASS verdicts unchanged. All three runtime guarantees now pass within stated evidence boundaries. The initial failure and its repair are retained above for audit.
