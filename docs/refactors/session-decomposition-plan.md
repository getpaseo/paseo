# Session God-File Decomposition Plan

`packages/server/src/server/session.ts` — 9116 lines, one `Session` class (declared line 724), 128 handlers, ~60 instance fields, 7 entangled domains. Goal: a **strictly behavior-preserving, incremental** decomposition into per-domain controllers, mirroring the existing `TerminalSessionController`.

## Chosen strategy: controller-context (per-domain option-bag controllers)

Each domain becomes a controller class in its own file with the **exact** contract the repo already proved twice (`TerminalSessionController` at `packages/server/src/terminal/terminal-session-controller.ts`, and `CreateAgentLifecycleDispatch`):

- An **options-bag constructor** injecting only what that domain reads.
- An **owned-type `ReadonlySet`** of message types.
- A **NON-async `dispatch(msg): Promise<void> | undefined`** that checks the owned-type set FIRST and returns `undefined` synchronously on a miss (verified at terminal-session-controller.ts:140-143).
- `start()` wired from `subscribeToOptionalManagers`, `dispose()` called by the shell's ordered `cleanup()`.

Session shrinks to a connection/dispatch shell: it keeps `handleMessage`, the `??` chain (1739-1751), `emit`/`emitBinary`, `sessionLogger`, connection identity, inflight metrics, lifecycle intents, and the **ordered** `cleanup()`. Each `dispatchXMessage` collapses to `return this.xController.dispatch(msg)`.

## Progress (shipped — diverged from the original filenames)

The first carves shipped as **deep modules with a narrow Host seam**, not the `dispatch(msg)`-owned-set controllers sketched below: `session.ts` keeps each `dispatchXMessage` switch and delegates per case to the subsystem. Home convention that emerged: session subsystems live at **`session/<domain>/`**, with `session.ts` as the orchestrator shell.

- **#1640 — VoiceSession** (`session/voice/voice-session.ts`, seam `VoiceSessionHost`): the STT/TTS/dictation/turn-detection subsystem. _(Originally landed at `server/voice/`; relocated under `session/` so all session subsystems share one home.)_
- **#1644 — CheckoutSession, read side** (`session/checkout/checkout-session.ts`, seam `CheckoutSessionHost`, port `CheckoutDiffSubscriber`): status, branch validate/suggest, diff subscribe/unsubscribe, manual refresh. The workspace-git observer already delegates `emitStatusUpdate`/`scheduleDiffRefresh` to it.

**Next carve — CheckoutSession mutation side (Slice 4 below).** The 17 checkout _write_ handlers still inline in `session.ts` (`dispatchCheckoutMessage`, ~2010) — branch switch/rename, commit, merge, merge-from-base, pull, push, PR create/merge, github set-auto-merge/get-check-details, PR status, PR timeline, github search, stash save/pop/list — move into the existing `session/checkout/checkout-session.ts` behind `CheckoutSessionHost`. The Slice-3 observer entanglement the table fears is already resolved: #1644 moved the status/diff read side into CheckoutSession, so the workspace observer delegates today and this no longer blocks on the WorkspaceController split.

### Why this is safe at the dispatch seam (verified)

`dispatchInboundMessage` builds `a() ?? b() ?? ... ?? dispatchMiscMessage()` and short-circuits on the first non-`undefined` **Promise object** (not its resolved value). Message-type spaces are **disjoint** (no duplicate `case` labels across switches), so at most one dispatcher matches any message — collapsing to delegation cannot change which handler runs. `dispatchTerminalMessage` (2150-2153) already proves this. Two quirks preserved verbatim: schedule/\* is reached via the chat dispatcher's OWN `default` arm (2183), not the top-level `??`; and `start_workspace_script_request` (a workspace type) is special-cased before terminal delegation (2150).

Rejected alternatives: **feature-module** (free functions + wide context bag) cannot own the live state machines (workspaceUpdatesSubscription, agentUpdatesSubscription, ~25 voice fields) and adds a competing idiom; **mixin-composition** preserves the shared-`this` god object verbatim and requires widening ~325 private fields to protected.

## Slice ordering (least-coupled first)

The task recommended **git/checkout as the first slice — OVERRIDDEN.** Verification: `emitCheckoutStatusUpdate` is called from exactly ONE site (session.ts:4915), inside the workspace-owned `syncWorkspaceGitObserver` callback that ALSO fires workspace effects over shared watch-target maps. Extracting checkout first forces splitting the hardest workspace/git seam before workspace is touched. The strictly safer first cuts are **chat-schedule-loop** (only knot: `handleChatPostRequest`; touches no shared observer/git/voice state) and **provider-catalog** (one shared collaborator + injected predicates).

| #   | Slice                                                                         | Effort | Risk   |
| --- | ----------------------------------------------------------------------------- | ------ | ------ |
| 0   | Test net + disjointness tripwire (no extraction)                              | M      | low    |
| 1   | ChatScheduleLoopController — **STOP FOR REVIEW after green**                  | M      | low    |
| 2   | ProviderCatalogController                                                     | M      | medium |
| 3   | Split shared workspace-git observer + agent-subscribe fan-out (no controller) | M      | high   |
| 4   | GitCheckoutController                                                         | L      | medium |
| 5   | WorkspaceController                                                           | XL     | high   |
| 6   | Voice prereqs: emit() purity + abortController ownership                      | M      | high   |
| 7   | VoiceSessionController                                                        | XL     | high   |
| 8a  | Agent-lifecycle config setters                                                | M      | medium |
| 8b  | AgentLifecycleController                                                      | XL     | high   |

---

## Slice 0 — Test net + disjointness tripwire (prerequisite)

No production code moves. Add `session.dispatch-seam.test.ts`. This is the gate the whole plan rests on, because chat/schedule/loop have **zero** handleMessage coverage today (verified).

Write RED-then-GREEN against the **current in-place** Session:

- `chat/post` happy path (asserts `chat/post` response emitted) + fanout-limit error path (asserts the `chat/post` error envelope, NOT a bubbled `rpc_error`).
- one `schedule/*` and one `loop/*` round-trip.
- a handler that throws **synchronously** emits `rpc_error{code:"handler_error"}` + an `activity_log` error frame.
- a handler that **rejects async** emits the SAME pair.
- a table-driven assertion that the union of all controllers' owned-type `ReadonlySet`s is pairwise disjoint and covers the dispatched `SessionInboundMessage` union (grows as controllers land).

**Tests:** `session.dispatch-seam.test.ts`, `session.test.ts`.

---

## Slice 1 — ChatScheduleLoopController ← STOP FOR HUMAN REVIEW after this ships green

**Move:** all 21 handlers (`handleChat*` ×7, `handleSchedule*` ×9, `handleLoop*` ×5), the three rpc-error emitters (`emitChatRpcError`/`emitScheduleRpcError`/`emitLoopRpcError` — **kept separate, not merged**), `toScheduleSummary` → `packages/server/src/server/chat/chat-schedule-loop-controller.ts`. Collapse `dispatchChatScheduleLoopMessage` + `dispatchScheduleMessage` to `return this.chatScheduleLoopController.dispatch(msg)`.

**SessionContext surface:** `emit`, `sessionLogger`, `clientId` (authorAgentId fallback), `chatService`, `scheduleService`, `loopService`, and a narrow agent-control port `{ listAgents, resolveAgentIdentifier, agentStorage.list }` for `handleChatPostRequest` mention fanout.

**Owned-type set MUST include all 7 `chat/*` + 5 `loop/*` + 9 `schedule/*` types** — schedule/\* is currently routed via the chat dispatcher's own `default` arm, so it must stay inside this one controller, or schedule requests silently no-op.

**Behavior note:** least-coupled domain. Move the three rpc-error emitters verbatim (they differ in default code + the `ChatServiceError` branch). **Tests:** `session.dispatch-seam.test.ts`, `loop-service.test.ts`, `session.test.ts`.

---

## Slice 2 — ProviderCatalogController

**Move:** 7 provider handlers + `emitProviderDisabledResponse` + `getProviderSnapshotEntryForRead` → `packages/server/src/server/provider/provider-catalog-controller.ts`. Move the `providers_snapshot_update` PUSH wiring (1235-1254) into the controller's `start()`/`dispose()`. Collapse `dispatchProviderMessage`.

**SessionContext surface:** `emit`, `sessionLogger`, `providerSnapshotManager` (**shared by reference** — stays a daemon singleton read by checkout/lifecycle/workspace), `isProviderVisibleToClient` (predicate closing over `this`, reads `appVersion` live), `downgradeModeIconsForClient`, `downgradeEntryModesForClient`, agent-control reads `{ listProviderAvailability, listDraftFeatures }`.

**Behavior note:** COMPAT correctness — PUSH and PULL paths MUST call the SAME injected visibility/downgrade closures, reading `appVersion` LIVE (mutated post-construction via `updateAppVersion`). Keep `COMPAT(providersSnapshot)` and `COMPAT(customModeIcons)` comments verbatim. Do NOT pull `resolveStructuredGenerationProviders`/`getFocusedAgentSelectionForCwd` in. **Tests:** `session.dispatch-seam.test.ts`, `daemon-e2e/models.e2e.test.ts`, `session.test.ts`.

---

## Slice 3 — Split the shared observer seams (prerequisite, no controller)

In-place refactor on the shell, two named fan-outs:

1. **workspace-git observer** (4910-4917): make `emitCheckoutStatusUpdate` and `onBranchChanged` injectable callbacks; keep `workspaceGitWatchTargets`/`workspaceGitSubscriptions` shared by reference.
2. **agentManager.subscribe callback** (~1298): refactor into `{ onAgentUpdate, shouldAutoAllowVoicePermission(event), onStreamEvent }`.

**Behavior note:** the single hardest seam, split exactly once before the two domains that co-own it. The observer fires BOTH workspace (`handleWorkspaceGitBranchSnapshot`, `emitWorkspaceUpdateForCwd`) and checkout (`emitCheckoutStatusUpdate`) effects; the agent-subscribe callback is invoked by agent EVENTS (not the `??` chain) and does lifecycle + voice work. Add a test asserting BOTH a `workspace_update` and a `checkout_status_update` fire from one simulated git snapshot change, and a voice-permission test for the auto-allow path. **Tests:** `session.workspace-git-watch.test.ts`, `session.workspaces.test.ts`, `voice-permission-policy.test.ts`, `session.test.ts`.

---

## Slice 4 — GitCheckoutController

**Move:** ~22 `checkout_*`/`stash_*`/PR/github handlers + `handleSubscribeCheckoutDiffRequest`/`handleUnsubscribeCheckoutDiffRequest` + `emitCheckoutStatusUpdate` + `checkoutDiffSubscriptions` → `packages/server/src/server/checkout/git-checkout-controller.ts`. Collapse `dispatchCheckoutMessage`.

**SessionContext surface:** `emit`, `sessionLogger`, `checkoutDiffManager` (move in + dispose teardown), `github` (shared), `workspaceGitService` (**shared spine**), `workspaceGitWatchTargets`/`workspaceGitSubscriptions` (**shared**), `providerSnapshotManager.listRegisteredProviderIds`. `emitCheckoutStatusUpdate` is now owned here and injected back into the workspace observer seam from Slice 3.

**Behavior note:** safe now that Slice 3 split the observer. `checkoutDiffSubscriptions` teardown moves to `dispose()`, called by `cleanup()` at its current ordinal (8530). **Tests:** `session.dispatch-seam.test.ts`, `checkout-diff-manager.test.ts`, `daemon-e2e/checkout-diff-subscription.e2e.test.ts`, `session.test.ts`.

---

## Slice 5 — WorkspaceController (XL)

**Move:** all workspace handlers (incl. re-homed `handleProjectRenameRequest` and `start_workspace_script_request`) + ~25 private workspace helpers + the whole `workspaceUpdatesSubscription` state machine → `packages/server/src/server/workspace/workspace-controller.ts`.

**SessionContext surface:** `emit`, `sessionLogger`, `projectRegistry`/`workspaceRegistry`/`downloadTokenStore`/script stores/editor cache (**owned**), `workspaceGitService` + watch maps (**shared with checkout**), injected `emitCheckoutStatusUpdate`/`onBranchChanged`, `terminalManager`/`killTerminalsUnderPath`, an `agentUpdatesSubscription` write via a narrow `bufferAgentUpdate` command, `providerSnapshotManager.listRegisteredProviderIds`.

**Behavior note:** the workspaceUpdatesSubscription machine moves WHOLE. The eight already-public workspace methods stay a public surface re-exposed via the shell. Re-homes are atomic remove-from-old-dispatcher + add-to-new-owned-set. **Tests:** `session.workspaces.test.ts`, `session.workspace-git-watch.test.ts`, `session.workspace-resolution-invariants.test.ts`, `session.test.ts`.

---

## Slice 6 — Voice prerequisites (emit purity + abort ownership)

In-place, separately reviewable. Split the `audio_output` TTS-debug branch out of `emit()` (8421-8468, bypasses to `onMessage` at 8454) so `emit` is a pure trace+onMessage sink. Move `convertPCMToWavBuffer` (674-701) to `speech/audio.ts`. Decide abortController ownership.

**Behavior note:** TTS-debug split and abortController ownership are the SAME decision (`ttsDebugStreams.clear()` is tied to `createAbortController` reassignment at 8359). Keep `emit` (with the universal trace) on the shell and inject it everywhere — no trace-less emit. Do NOT inject the AbortController by value. Add: a TTS-debug persistence test (with the debug env flag) before the move, and a barge-in→cleanup regression test asserting the NEW run's signal is aborted. **Tests:** `voice-roundtrip.e2e.test.ts`, `voice-permission-policy.test.ts`, `session.test.ts`.

---

## Slice 7 — VoiceSessionController (XL)

**Move:** voice handlers + ~25 voice fields + the TTS-debug hook (Slice 6) + `voiceModeAgentId`/`isVoiceMode` + the `shouldAutoAllowVoicePermission` predicate (Slice 3) → the existing `packages/server/src/server/session/voice/voice-session.ts` (see Progress above). Carve voice types out of `dispatchVoiceAndControlMessage`, leaving infra (restart/shutdown/heartbeat/ping/abort) on the shell.

**SessionContext surface:** pure `emit`, `emitBinary`, `hasBinaryChannel`, `sessionLogger`/`sessionId`/`paseoHome`, `getSpeechReadiness`, agent-control port `{ loadAgent, reloadWithSystemPrompt, interruptIfRunning, isRunning, sendSpokenText, buildAgentPrompt }`, `getSignal`/`abortCurrent` (Slice 6).

**Behavior note:** depends on Slices 3 + 6. `cleanup()` stays the ordered orchestrator and calls `voiceController.dispose()` at the position the inlined voice teardown occupies today (8505-8525). **Tests:** `voice-roundtrip.e2e.test.ts`, `voice-local-agent.e2e.test.ts`, `session.voice-mcp-config.test.ts`, `session.test.ts`.

---

## Slice 8a — Agent-lifecycle config setters

Parameterize the 4 setter envelopes `handleSetAgentMode/Model/Feature/Thinking` (4209-4390) into one helper; re-home `handleListCommandsRequest` (misfiled in `dispatchMiscMessage`). Add a handleMessage-driven **failure** test per setter (force the command to reject, assert both the `*_response{accepted:false}` AND the `activity_log` error frame in order) BEFORE collapsing. **Tests:** `session.test.ts`, `session.lifecycle-boundary.test.ts`.

## Slice 8b — AgentLifecycleController (XL, LAST)

**Move:** remaining lifecycle handlers + the `agentUpdatesSubscription` fan-out (`bufferOrEmitAgentUpdate`, `flushBootstrappedAgentUpdates`, `matchesAgentFilter`, `forwardAgentUpdate`) → `packages/server/src/server/agent/agent-lifecycle-controller.ts`. Collapse the three lifecycle dispatchers.

**SessionContext surface:** `emit`, `sessionLogger`, `agentManager`/`agentStorage` (**owned**), injected `forwardAgentUpdate` → `buildProjectPlacementForCwd` (backed by WorkspaceController), `agentUpdatesSubscription` accessor (owned; workspace writes via `bufferAgentUpdate`), `isProviderVisibleToClient`, `resolveCreateAgentWorkspace`, `supports`, `mcpBaseUrl`, `terminalController.killTerminalForClose`.

**Behavior note:** done LAST — the shared-projection hub. `handleCloseItemsRequest` splits its terminal-kill half from its agent-archive half. **Tests:** `session.test.ts`, `session.wait-for-finish.test.ts`, `session.create-agent-title.test.ts`, `session.lifecycle-boundary.test.ts`, `daemon-client.e2e.test.ts`.

---

## Cross-cutting invariants (every slice)

- **Always** run `npm run typecheck` and `npm run lint` after each slice; run `npm run build:server` before diagnosing cross-package type errors.
- Controller `dispatch` is **NON-async**, guarded by an owned-type `ReadonlySet` check returning `undefined` synchronously on miss. Never `async dispatch`.
- Controllers add **no** try/catch inside `dispatch` — error handling stays in `handleMessage`.
- `cleanup()` stays the single ordered teardown orchestrator on the shell.
- Move domain error emitters **verbatim**; treat any cross-domain emitter merge as a separate, test-guarded change.
- Per-slice typecheck/lint/format via `npm run` scripts; never re-run the full suite locally (run only the listed files with `--bail=1`).
