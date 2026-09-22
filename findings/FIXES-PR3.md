# Fix plan for PR #3

This ledger owns current finding status. [CR1](CR1.md) remains the historical review snapshot.

**Current scope:** ROUND-2 below supersedes ROUND-1 recommendations. The user explicitly approved six narrower fixes and retained workspace-first TypeScript. ROUND-1 is historical planning, not the authorized implementation list.

## ROUND-2 — Implement the lowered scope, 2026-09-22

Authorization: the user approved the six-fix summary with “ok, implement,” then authorized publication with “commit and push.” Keep workspace-first TypeScript with bundled fallback. Base/candidate remain those in ROUND-1; initial working tree contains only untracked findings records.

| Approved fix                                              | Original findings                                | Production touched estimate | Test additions estimate |
| --------------------------------------------------------- | ------------------------------------------------ | --------------------------- | ----------------------- |
| Compact Changes with explicit workspace/navigation inputs | CR1-1, S1/F1 → P1                                | 100–180                     | 60–110                  |
| Passive hover errors never open a modal                   | CR1-3, S2/F1 → P2                                | 50–100                      | 90–150                  |
| Reachable pointer card, usable keyboard Inspect/Escape    | CR1-4, S2/F1 → P2                                | 80–170                      | 60–110                  |
| Reuse pointer hit, avoid unchanged state/LSP updates      | CR1-5a / CR1-6 notification portion, S2/F0 → P2  | 35–75                       | 40–80                   |
| Short failure cooldown and bounded cancellation/timeouts  | CR1-7 failure portion, S2/F2 → P2; related L3/L4 | 65–135                      | 100–180                 |
| Normalize retained workspace roots                        | CR1-14, S3/F3 → P3                               | 3–7                         | 15–30                   |

Explicitly excluded by the approved scope: runtime caps/pooling/eviction, picker redesign, snippet caching, disk/blob-read optimization, snapshot restructuring, split-pane conflict machinery, RPC renaming, import/standards cleanup, and new trust machinery. CR1-2's workspace runtime selection is deliberately retained for this personal development workflow, not fixed. Revisit trust gating if inspecting unfamiliar unexecuted checkouts becomes a required workflow. Previously rejected CR1-8/11 and the context-menu subclaim remain rejected. Other excluded open findings remain deferred under the user's scope decision, with their prior triggers and evidence preserved below; no claim of whole-PR closure.

Baseline: `npm run typecheck` and `npm run lint` passed before implementation (logs `/tmp/pr3-implementation-baseline-{typecheck,lint}.log`). Two fix workers own app and server respectively; root owns browser tests, integration and records. A third independent agent will verify closure against the actual changes. No broader review round or full suite is planned.

### Implementation and closure

All six approved corrections are implemented, with independent closure inspection, in fixing commit `7da2f317e13f689db11e827ec8c935c78b33ad69`. The pre-commit formatting, lint and typecheck gates passed. Formatting preserved the verified source snapshot below. Review records are committed separately.

| Finding / approved portion                     | Current status                         | Actual correction and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CR1-1                                          | verified-closed                        | Language actions receive explicit workspace/navigation inputs. Both Changes hosts supply them; compact navigation preserves the full range and closes Explorer. Real browser reproduction failed with `PaneContext is required` before the correction and passes afterward.                                                                                                                                                                                                              |
| CR1-3                                          | verified-closed within tested boundary | Hover presentation cannot produce a navigation modal. Action tests cover returned/thrown failures, cancellation and retry. A real browser disconnect was not exercised.                                                                                                                                                                                                                                                                                                                  |
| CR1-4                                          | verified-closed within tested boundary | Local dwell/dismissal grace makes pointer cards reachable. Deliberate Inspect owns focus and Escape restoration. Real browser verifies those behaviors. Inspect now uses Alt+F12, displayed in the menu: the previous Mod-k Mod-i chord was intercepted by Command Center. Assistive technology itself was not tested.                                                                                                                                                                   |
| CR1-5a                                         | verified-closed                        | Pointer movement reuses its hit test. Repeated closed-state dismissal does not notify subscribers. Source inspection plus action tests; no claim of a measured performance gain. CR1-5b remains deferred.                                                                                                                                                                                                                                                                                |
| CR1-6, unchanged document notification portion | verified-closed                        | Process-local document synchronization skips unchanged text and shares an identical pending write. Tests exercise unchanged, changed, reopened and concurrent writes. Disk/blob work remains deferred.                                                                                                                                                                                                                                                                                   |
| CR1-7, failure portion; L3/L4                  | verified-closed within tested boundary | Session-owned five-second failure cooldown and thirty-second query deadline bound failures. Cancellation settles the caller promptly; uncooperative work retains its deadline. Captured process identity prevents stale work retiring a replacement. Recovery tests cover startup failure, cancellation, deadlines, disposal and real child exit. Runtime admission, pooling and eviction remain deferred; cancellation of an intentionally uncooperative real LSP was not demonstrated. |
| CR1-14                                         | verified-closed                        | Retained roots use the same lexical normalization as stored workspace keys; recovery test verifies equivalent paths retain the process.                                                                                                                                                                                                                                                                                                                                                  |

Maintenance change: the app carries explicit workspace/navigation inputs through existing hosts, a small injectable action clock, and localized hover state. The server adds a typed runtime test port and process-local document notification owner while preserving per-session process/buffer ownership. Workspace-first TypeScript with bundled fallback, wire contracts and capability gating remain unchanged. Independent inspection found an accidental editor preview-root substitution and the old keyboard shortcut conflict; both were corrected and the affected browser behavior verified. Server inspection also caught and corrected startup-default shadowing and exit-time disposal ordering before final gates.

Actual size, excluding findings records and generated output: **production +420/−149 across 15 files (569 touched lines); tests +637/−39 across five files (676 touched lines)**. Production stays within the 330–670 estimate; test additions stay within the 365–660 estimate. Tests include three new unit files and extensions to existing navigation/browser coverage.

### Executed verification

- Baseline and final `npm run typecheck` and `npm run lint`: passed. Final lint reports zero warnings/errors. Final logs: `/tmp/pr3-final-typecheck.log`, `/tmp/pr3-final-lint.log`.
- `npm run build:server`: passed, including dependency declarations and CLI build; `/tmp/pr3-build-server.log`.
- App targeted unit files `src/code-language/actions.test.ts` and `src/screens/workspace/workspace-file-open-command.test.ts`: eight tests passed, reported by the UI worker. Server targeted files `src/server/code-language/session.test.ts`, `process.test.ts`, and `session-recovery.test.ts`: eighteen distinct tests passed. The original combined run passed seventeen; the recovery file passed all eight after adding the real-exit regression. Unit evidence is in the worker tool outputs, not disk logs. Already-green unchanged files were not rerun merely to combine totals.
- Three real-host browser scenarios passed: editor hover/Inspect/definition/usages; working-diff intelligence; compact Changes navigation. The initial compact red evidence is `/tmp/pr3-compact-red.log` and `/tmp/pr3-compact-red-artifacts`. Two final diff/compact passes are in `/tmp/pr3-browser-green.log` (that run also exposed the old Inspect shortcut failure), with artifacts copied to `/tmp/pr3-browser-diff-compact-green`. The repaired editor-only rerun passed in `/tmp/pr3-browser-editor-green.log`, artifacts `/tmp/pr3-browser-results`.
- Browser command: `npm run test:e2e --workspace=@getpaseo/app -- --config /tmp/pr3.playwright.config.ts e2e/browser/code-language.spec.ts`; the repaired editor rerun added `--grep 'TypeScript hover'`. The temporary config uses installed Chromium headless-shell revision 1234 because the default revision 1208 was unavailable. Test servers used isolated homes and ephemeral ports; the main daemon was not restarted.
- npm formatting scripts and `git diff --check`: passed. No full test suite was run. Native, packaged Electron launch, real browser disconnect, and quantitative performance remain unverified; none is claimed by these checks.

Tested source snapshot: sorted SHA-256 manifest of the twenty changed/new production and test files at `/tmp/pr3-final-source-manifest.sha256`; manifest SHA-256 `1f895e15852aafd7d1b8d4197a373e772fdae4e0972fb7b75b2569b208ac4aa9`. The manifest excludes this ledger and CR1. Temporary evidence paths are local session artifacts. ROUND-1 below preserves historical proposals; its pending-status language does not supersede this round.

## ROUND-1 — Planning, 2026-09-22

- Request: `/infi-fix-planning` following CR1. Mode: plan-only. No implementation, commits, external comments, or risk acceptance authorized by this invocation.
- Base: `f777bc1b38090a427fe64b723e4df6303d31f7d4` (`paseo-customizations`). PR identity and actual review base come from CR1 and the supplied handoff; live PR metadata was not refreshed.
- Candidate: `58edd998de931e6effa0f17bd3d1662e9ffb4c11`, branch `explore-typescript-lsp-editor-diff`. Product/test/config content matches CR1. Only the untracked review records were present at planning start.
- Capacity: root plus three read-only planners, four concurrent agents total. No fixers or closure verifiers ran.
- History: first fix round; no previous decisions, attempted corrections, or recurrences.

Protect hover, definition navigation, and find-usages in the existing editor and current-text diff surfaces, including compact web/desktop Changes. Preserve per-client unsaved buffers, external declaration navigation, stale-snapshot rejection, and the existing protocol contract. Native editor intelligence and historical/base-side analysis are not added by this round. These boundaries come from the PR implementation and existing tests; resource budgets and handling conflicting split-pane buffers are explicit proposed product choices below.

Every test and reproduction below is **proposed**, unless explicitly identified as executed. Historical green tests in CR1 are not closure evidence for these proposed corrections. No finding is verified-closed.

### Decision sheet

Sizes are rough added/removed LOC, production first and tests second; they are not measured diffs or commitments. Documentation and generated output are noted separately. No alternative is included in the default estimates. Shared integration fixtures are counted only in FP11.

| Plan | Problem → default solution                                                                                                                                    | Maintenance change                                                                            | Decision / coverage                                                              | Size context                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| FP1  | **Reading TypeScript can execute repository code.** Always use the daemon's bundled compiler.                                                                 | Deletes workspace-controlled executable selection.                                            | Mechanical; CR1-2 (S1/F2 → P1)                                                   | Prod +1–3/−7–12; tests +35–70                                         |
| FP2  | **Compact Changes crashes; hidden owners can retain popups.** Pass workspace/navigation inputs explicitly and tie actions to owner activity.                  | Removes implicit pane requirement; reuses retained-panel activity.                            | Mechanical; CR1-1 (S1/F1 → P1), CR1-13 (S2/F3 → P3)                              | Prod +90–165/−20–45; tests +95–175                                    |
| FP3  | **Hover failure blocks the app and cards are hard to reach.** Separate hover from navigation results; give pointer and keyboard inspection explicit behavior. | One presentation owner; bounded pointer grace and focus ownership.                            | Mechanical failure fix; judgment interaction choice; CR1-3/4 (S2/F1 → P2)        | Prod +130–240/−50–110; tests +200–330                                 |
| FP4  | **Pointer movement repeats hit testing and publishes unchanged state.** Reuse the hit and make closed-state publication idempotent.                           | Removes duplicate work without another scheduler.                                             | Mechanical; CR1-5a (S2/F0 → P2)                                                  | Prod +10–25/−10–20; tests +30–60                                      |
| FP5  | **Results lose snippets on scroll and bypass shared UI.** Cache snippets by location within each result session; use the shared sheet and themed primitives.  | Removes custom modal presentation; retains bounded result rendering.                          | Judgment presentation choice; CR1-5b/9 (S2/F0 → P2)                              | Prod +145–260/−140–245; tests +120–210                                |
| FP6  | **Repeated queries resend unchanged text and reread immutable Git blobs.** Deduplicate notifications and reuse blobs within one diff calculation.             | Process owns synchronization; diff invocation owns immutable reads. Fresh disk guards remain. | Mechanical corrections; judgment residual for disk-scan cost; CR1-6 (S2/F0 → P2) | Prod +30–60/−10–25; tests +90–160                                     |
| FP7  | **Inactive or failing language runtimes accumulate.** Bound admission, reclaim inactive runtimes, back off failures and settle cancelled queries.             | Adds one daemon capacity owner; session buffers stay isolated.                                | Judgment; CR1-7 (S2/F2 → P2), CR1-14 (S3/F3 → P3), L3/L4                         | Prod +182–305/−41–87; tests +235–390                                  |
| FP8  | **Text-coordinate conventions can drift.** Share BOM/text helpers and prove app/server agreement.                                                             | Removes duplicated convention; preserves distinct validation phases.                          | Mechanical; CR1-10 (S2/F2 → P2), narrowed rationale                              | Prod +25–50/−10–25; tests +50–100/−0–10                               |
| FP9  | **Split panes silently analyze another pane's edits.** Detect divergent leases and withhold ambiguous workspace intelligence.                                 | Keeps editing independent; adds an explicit recoverable conflict.                             | Judgment, restricts intelligence during conflict; CR1-12 (S2/F3 → P3)            | Prod +65–120/−15–30; tests +100–180                                   |
| FP10 | **Small standards violations and disputed conventions.** Correct tags/copy/docs; retain compatible wire names pending a naming decision.                      | No protocol migration merely for spelling.                                                    | Mixed fixes/dispositions; CR1-15 (S3/F0–F2 → P3), L2                             | Prod/docs +3–8/−5–12; no mirroring tests                              |
| FP11 | **Real dispatch and packaged launch remain unproved.** Add one integrated wire/browser/package evidence pass.                                                 | Reuses isolated harnesses; replaces fragile geometry and weak assertions.                     | Mechanical proof work; unnamed CR1 test gaps                                     | Prod +15–35; tests/harness +150–280/−10–25; generated output excluded |

Recommended implementation order: FP1 → FP2 → FP3/FP4 → FP5 → FP8/FP6 → FP7 → FP9 → FP10 → FP11 integration. Small independent parts, such as root normalization, may move earlier. The table is a recommendation, not implementation authorization. A later bare “go” would select these defaults and their explicitly proposed residual dispositions; it would not authorize committing, pushing, or changing external records. No choices have been accepted yet.

### Reconciliation and current status

All findings are first-round known-open observations, not recurrences. Preserve the original ratings even where the claimed mechanism is rejected. The subdivisions below only allocate composite findings; they are not additional findings.

| Input        | Current status                            | Owner / disposition                                                                |
| ------------ | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| CR1-1, CR1-2 | Planned                                   | FP2, FP1 respectively; P1 red/green proof required                                 |
| CR1-3, CR1-4 | Planned                                   | FP3                                                                                |
| CR1-5        | Planned                                   | FP4 owns 5a pointer work; FP5 owns 5b snippet scrolling                            |
| CR1-6        | Planned, residual decision pending        | FP6; preserve before/after disk guards, measure their cost                         |
| CR1-7        | Planned, policy decision pending          | FP7                                                                                |
| CR1-8        | Rejected as reported                      | D1 below; opening uses the existing filesystem-root read target                    |
| CR1-9        | Planned                                   | FP5                                                                                |
| CR1-10       | Planned with narrowed mechanism           | FP8; independent validation phases are required                                    |
| CR1-11       | Rejected as an introduced regression      | D2 below; base already failed the claimed branch-mode case                         |
| CR1-12       | Planned, behavior decision pending        | FP9                                                                                |
| CR1-13       | Planned; original reproduction unexecuted | FP2                                                                                |
| CR1-14       | Planned                                   | FP7                                                                                |
| CR1-15       | Mixed; see FP10                           | Tags/copy/docs planned; naming/import dispositions pending; menu subclaim rejected |
| L1           | Open; proposed deferral                   | D3; no current authority expansion established                                     |
| L2           | Open; proposed deferral                   | FP10, currently guarded by web-only entry points                                   |
| L3, L4       | Planned latent-hazard corrections         | FP7; no current P assigned, S-if-unguarded S2                                      |

No fixing commits exist. Nothing has been marked accepted-risk, deferred by the user, or verified-closed.

### FP1 — Reading TypeScript must use trusted runtime code

Opening a repository file can currently select and execute that repository's `node_modules/typescript/lib/tsserver.js`. Recovery is not reliable after execution; the affected workflow is inspecting an unexecuted checkout. `TypeScriptProcess` already owns selection. Remove its workspace-rooted `createRequire`, keep daemon-rooted resolution, explicit `tsserver.path`, asar unpacking, disabled typing acquisition and disabled local plugin loading. This removes implicit workspace-specific compiler versions, for which no support requirement was found.

Inspected `code-language/process.ts`, installed language-server resolution/forking, desktop packaging, and SECURITY.md. The authority must be the daemon installation, with no caller trust flag to forget. The security doc specifically names automatic workspace actions; it does not literally enumerate every possible form of execution. The read-triggered compiler execution mechanism nevertheless stands independently.

Alternative: tie workspace compiler selection to execution trust. That adds a policy decision about whether running setup grants compiler trust, propagates trust through session creation/invalidation, and maintains two selection paths. Estimate prod +100–180, tests +100–170 before UI changes. It is disproportionate without a requirement for repository-specific compiler versions.

**Proof:** Use a real-language-server fixture whose workspace tsserver writes a harmless fixed marker and delegates to the bundled tsserver. A completed correct hover establishes the execution barrier. Red: marker exists. Green: identical successful hover and no marker. Never serialize environment variables. Exercise `CodeLanguageSession.query`, then reuse the fixture through the real daemon/client path in FP11. Keep alias/reference/declaration coverage and verify the packaged runtime. A path-string assertion alone does not prove the P1 correction.

Apply first; `process.ts` overlaps FP6/FP7. No new runtime-selection abstraction is needed.

### FP2 — Keep language actions independent of the pane shell

Compact Explorer → Changes calls `DiffSurface` without a `PaneProvider`, but `useLanguageActions` requires it before checking enablement. Separately, retained hidden owners can leave a portal visible or allow a late query to reopen it. Widening the window works around the first issue; dismissal is the intended recovery for the second.

Pass the narrow workspace identity and location-navigation callback into language actions. Editor callers adapt their valid pane context; `ChangesSurface` supplies scope and navigation through diff props. Extend the compact host's existing file-open command to preserve the complete line/column location and close Explorer after opening. Reuse `useRetainedPanelActive()` to gate portal registration immediately and dismiss/cancel on deactivation. It defaults active outside retention, avoiding another required provider.

Inspected `use-actions.web.ts`, editor view, diff types/index/surface, `ChangesSurface`, `diff-panel.tsx`, compact sidebar/host, `workspace-file-open-command.ts`, file-open helpers and pane context; basis includes `docs/explorer-sidebar.md`. Read `docs/expo-router.md` before any implementation touching active selection; preserve the existing open-command semantics.

Alternative for scope: a language-scope provider in both shells, prod +100–180/−20–40 with similar tests. It adds another implicit mounting obligation without avoiding location-aware navigation work. Returning null for missing PaneContext silently removes a supported feature and is not selected. Alternative for retention: hide without cancelling; smaller, but stale results reopen on return. Reuse owner activity rather than adding pane-focus assumptions.

**Proof:** P1 red/green real browser at compact width, committed TS fixture plus modification: open Explorer → Changes, assert diff visible and no page error, invoke navigation, verify exact file/range and Explorer closure. Repeat wide preferred-pane navigation; commit diffs still mount without current-text actions. For retention first establish an actual supported keyboard tab/workspace transition while the picker is open; assert dialog/focus scope disappear, new content accepts input and late completion cannot resurrect it. Repeat compact Explorer hiding. If the proposed shortcut is intercepted, record that limit instead of claiming it reproduced.

Mechanical. Overlaps FP3/FP5 in hooks/overlay; one UI integration owner must serialize those edits.

### FP3 — Keep hover passive and make deliberate inspection usable

A returned language error or thrown query failure publishes a modal even for passive hover. Moving toward an existing card dismisses it before its stale-file action can be used. Branch by operation before interpreting results and restrict popup operations to definition/references. Hover produces only local hover/closed states. Preserve visible retry/recovery for deliberate navigation. Correction to CR1: an editor hover returning `stale` does not itself enter the popup branch; returned errors and exceptions do.

Use the existing action owner for cancellation and presentation. Preserve the target while the pointer crosses from its symbol rectangle into the card; use bounded grace and cancel replacement when the card gains pointer/focus. Passive hover never moves focus. Deliberate keyboard/context-menu Inspect exposes an accessible anchored region, focuses content/action, and restores focus on Escape. Reuse existing safe-zone geometry logic where suitable; do not treat the whole editor rectangle as the trigger.

Inspected actions/editor/overlay, diff movement, hover-safe-zone and overlay registration. `useWebOverlayRegistration` currently focuses/traps registered scopes, so passive registration needs a narrow non-focus-owning mode if sharing Escape arbitration. Preserve defaults for existing dialogs. The shared owner, not each caller, enforces the distinction; remove local global-Escape handling when the shared contract replaces it.

Alternative: guard the two failure branches (+5–15 prod) and make pointer cards noninteractive, reserving the stale-file action for explicit Inspect (+40–80/−30–60 prod). This lowers interaction machinery but removes the existing pointer affordance and leaves repeated operation guards. Selecting it needs an explicit behavior decision. Do not add a second independent hover state machine beside the current action owner.

**Proof:** Typed adapters through `WorkspaceLanguage` → `LanguageActions`: returned/thrown failure, abort, empty hover, diff stale, success, retry and open-current. Real browser with its isolated daemon unavailable: no passive modal, backdrop or focus theft; explicit usages still reports an actionable failure. Move stepwise from symbol into card and use the stale action in editor and diff. Keyboard Inspect announces/exposes content, Escape restores focus, and a higher modal alone consumes Escape. Shared overlay changes require focused neighboring dialog checks. Never disconnect/restart the main daemon for this proof.

Failure routing is mechanical; interactive hover/focus policy is judgment. Depends on FP2 activity and FP4 idempotent targeting; serialize overlapping action/overlay files.

### FP4 — Avoid duplicate pointer work

`DiffSurface.pointerMove` calls `pointHit` twice, and dismissing already-closed actions publishes new React state on every event, including non-TS diffs. Compute the hit once and reuse it for selection and language targeting. Cancel timers/requests even when skipping an unchanged-state publication; idempotent rendering must not leave pending hover work alive.

Inspected `surface.web.tsx`, `hit-testing.ts`, actions, and render-profiler utilities. This keeps responsibility at the pointer/action boundaries and removes duplicate work. Alternative animation-frame scheduling (+30–60/−10–20 prod) adds timing state and selection/hover latency risk before demonstrating a need.

**Proof:** Record the same pointer sweep and fixture size over large TS/non-TS diffs before and after. Measure overlay React commits, hit-test calls and browser self-time. Verify drag selection and comment affordances. Do not claim all diff React commits disappear: existing comment behavior has separate publication paths. Mechanical; integrate with FP3.

### FP5 — Preserve result identity while reusing shared presentation

Every virtual window changes the snippet query key; loaded rows blank, while the custom dialog owns its own theme, spacing and keyboard behavior. Use a result-session cache keyed by full location identity; request only missing visible locations, associate each returned snippet with its requested location, and reject late responses from prior result sessions. Reset with a new result set so cached content does not persist indefinitely. Keep requests bounded.

Move the dialog shell to `AdaptiveModalSheet` with non-scrolling outer content and shared header/search/buttons. Use theme tokens and reactive styling for the bounded list; retain specialized web rows where needed. Remove the local backdrop/card presentation and one-time theme snapshot. Add virtual-list `aria-setsize`/absolute `aria-posinset` and measured viewport-based keyboard scrolling.

Inspected overlay, `useFetchQuery`, Combobox, AdaptiveModalSheet, diff theme integration, design/Unistyles/floating-panel docs. CR1's proposed Combobox replacement is not directly applicable: Combobox requires an anchor, owns another overlay and maps all options. Also, `dataShape: "list"` alone can put old positional snippets beneath different new locations; it is not a correctness fix.

Alternatives: per-location queries (+30–60/−10–20 prod for caching) reuse query machinery but expand one batch to up to twelve RPCs. Extracting reusable inline picker content from Combobox (+180–300/−120–200 prod; tests +100–160) adds a shared API and requires auditing its other consumers. Neither is justified over local identity caching and shared sheet presentation here.

**Proof:** At least 300 uniquely identifiable references; scroll three windows, return, filter during pending loads, and assert each path retains its own snippet. Measure request count and loaded-row blanking before/after. Exercise arrows/Enter in short viewports, empty/loading/error/retry/stale states, theme switching while open, compact/wide screenshots, accessibility metadata and focus restoration. A spacer's presence alone was not a listbox ownership violation; descendant options remain descendants.

Judgment presentation choice; cache correctness is mechanical. One integration owner with FP3. Shared fixture cost belongs only to FP11.

### FP6 — Reuse unchanged text and immutable Git content

`executeQuery` increments an LSP version and synchronizes full text on every query. `getCheckoutDiff` fetches a committed blob for highlighting and again for snapshot identification. Keep the last successfully synchronized normalized text at `TypeScriptProcess`, skipping `didChange` when equal and clearing it on close/replacement. Reuse immutable `(target SHA, path)` results, including missing blobs, within one diff invocation across highlighting and snapshot identification.

Inspected process/session, snapshot capture/identify, `checkout-git.ts` tracked highlighting and real server tests. The notification owner now handles deduplication for all callers; a request-local loader replaces repeated immutable reads without watcher invalidation. Temporary disk-only query documents may still close after the last reader; do not promise cross-query retention.

**Recommended residual:** retain the full before/after disk captures and fresh post-LSP validation initially. They guard different race windows. The report's raw counts do not establish that each read is removable. This part stays open with proposed deferral pending measured cost; it is not silently closed by notification/blob changes.

Alternative: replace pre-diff content capture with stamps, then stable stat/read/stat after generation (overall prod +45–95/−20–50; tests +90–160). This adds metadata assumptions to content-validity proof. Select only with explicit same-size/mtime/rename/racing-edit evidence and a demonstrated benefit. A cross-refresh cache adds significantly more invalidation state (+150–250 prod) and is disproportionate before measurement.

**Proof:** Notification adapter plus real LSP behavior: repeated retained unchanged queries cause no changes, one edit causes one change, close/restart replays current text, two sessions retain their own types. Diff tests preserve BOM/CRLF, rename, missing blob, deleted/binary/large files, transformed/whitespace patches, disk changes during generation and during query. Benchmark identical 200-file structured diffs before/after with wall time, read/hash and Git subprocess counts; separately count repeated retained-hover notifications. The disk-scan residual is reconsidered if it materially dominates measured refresh cost.

Mechanical corrections with a judgment residual. FP8 owns normalization agreement; serialize process/session/snapshot changes with FP1/FP7. No return of cached start-time disk content as proof of post-query freshness.

### FP7 — Bound runtime demand without mixing client buffers

One process per connection/workspace preserves distinct unsaved buffers, but retained documents pin processes and failed launches retry at hover cadence. Keep isolation. Introduce one daemon-owned admission budget while sessions retain documents independently of process lifetime.

**Proposed policy:** four admitted workspace runtimes per daemon, each including wrapper and tsserver child. Reclaim the least-recently-queried runtime with no active readers, replaying retained buffers on its next query. If all four are busy, return an existing actionable error instead of spawning or queuing without a bound. Keep the five-minute idle interval but base it on query activity, not document retention. Use a short failure cooldown; a proposed initial value is five seconds, with success resetting it and normal eviction excluded. These numbers are proposed defaults, not measured optima or hard memory limits.

Count starting/running/stopping runtimes against admission; release the slot only after confirmed process-tree termination. Add awaitable shutdown at the process boundary. Bound the whole query, including start, sync, LSP response and release, using the existing query deadline policy. Cancellation must settle locally even if the server ignores it; timeout/wedged work invalidates/stops the runtime and late generations cannot publish. Put workspace acquisition inside the error boundary so calls after disposal return a response instead of rejecting out of dispatch. Normalize `retainWorkspaces` roots with the same lexical `resolve()` used for keys; do not introduce realpath only at this comparison.

Inspected all language lifecycle files, session construction/disposal, workspace mutations, WebSocket teardown, correlated client requests and tree-kill. Daemon owns admission; sessions own documents/reader leases; process adapter owns transport and stop completion. This adds capacity, cooldown and shutdown states but removes perpetual process retention and dependence on cooperative cancellation. It does not pool shared document URIs across clients.

Alternative A: cooldown/local settlement/query-idle reap without a global cap, prod +80–150/−25–55 and tests +150–240. It is smaller and avoids capacity-denied behavior but requires explicit acceptance of uncapped simultaneous demand. Alternative B: shared per-cwd process with serialized complete overlay swapping, prod +300–500 and tests +300–500; it adds cross-client document restoration, cancellation ordering and head-of-line blocking. Not recommended. For CR1-14 alone, global registry normalization is broader than the local key rule.

**Proof:** Inject typed process/clock adapters for admission across sessions, counting startup/shutdown; all-busy error; idle eviction with retained buffers; rehydration; cooldown and recovery; cancellation only after observing actual request entry; an uncooperative request; crash during query; no late-generation response; disposed-handle response. Real processes verify normal recovery and buffer isolation. Compare equivalent lexical roots through public generation/content results. Await shutdown before temporary directory removal, then use the established Windows retry options. Record peak runtime/process count and RSS under a defined multi-workspace/client fixture. Windows/macOS/Linux claims require actual execution on those platforms.

Judgment cap/refusal/cooldown policy; cancellation and root normalization are mechanical. Apply after FP1/FP6. FP3 must make capacity errors harmless during passive hover. L3/L4 remain unprioritized latent hazards; this plan removes the teardown dependence that currently bounds them.

### FP8 — Share coordinate conventions, not distinct validation duties

Capture-time eligibility, app hit-coordinate conversion, pre-query disk/buffer validation and post-query race detection enforce different phases. The report's suggested request shape already exists. Keep old/deleted/commit cells disabled and retain the server checks. Move only platform-neutral text normalization and first-line BOM coordinate conversion into shared code-language utilities, with hashing staying server-side and wire schemas remaining pure.

Inspected `diff-snapshot.ts`, content helpers, `language-target.ts`, session query checks and protocol request shape. This removes duplicated coordinate conventions without making the UI claim support for historical documents. No wire field changes are needed. Architecture prose should describe why historical buffers must not replace live ones, not enumerate code branches.

Alternative: keep helpers separate and add cross-boundary behavior tests only, prod unchanged, tests +60–110. Lower churn, but the ordinary task of changing BOM handling still requires coordinated edits. Building historical document namespaces is a separate feature, not the fix for this finding.

**Proof:** Real diff creation → app target conversion → language query with BOM, CRLF and supplementary Unicode, unified/split layouts, and exact symbol/range agreement. Preserve stale results after buffer mismatch or disk changes and ineligible old/deleted/transformed cells. Mechanical. Integrate with FP6, sharing fixtures instead of duplicating normalization tests. Documentation roughly 5–12 touched lines, counted with FP10 if edited together.

### FP9 — Make conflicting split-pane buffers explicit

Two per-pane editor models retain one language document by path; either pane overwrites that entry, so intelligence silently describes the other pane. Track contents per lease. When all leases agree, sync one version as now. When they diverge, withhold ambiguous workspace queries and provide an actionable explanation for deliberate commands; passive hover follows FP3. Resolve when panes agree or a conflicting pane closes. A conflict in an imported file also affects a query, so checking only the requested path is insufficient.

Inspected FilePane model ownership, editor retain/update/release and `WorkspaceLanguage`. This preserves independent editing but intentionally restricts intelligence during conflict. Merely keying the client map by pane does not isolate the wire/LSP document URI. Throwing from retain into React or selecting an arbitrary first/last writer is not acceptable.

Alternative: share the actual editor document/model across panes, prod +140–280/−50–110, tests +150–250. That removes ambiguity by construction but changes save conflict, disposal, undo and unsaved-edit ownership across the editor, exceeding a local language feature correction. Full independent language sessions per pane add runtime cost and dependency ownership instead.

**Proof:** Real split panes with divergent unsaved literal types must never silently return the other pane's type. Identical leases still work; closing either conflicting pane restores service; a conflicting imported dependency blocks misleading analysis; reconnect replays unambiguous state. Unit tests use the typed transport adapter; browser proof exercises actual open-to-side. Judgment, dependent on FP3 error presentation and FP7 buffer replay semantics.

### FP10 — Apply small standards corrections without a breaking rename

Match the existing app-side dated `COMPAT(codeLanguage)` tag at declaration and advertisement; use `...` in changed English copy; remove architecture prose that restates timeout/constants/branches while retaining isolation rationale and new-side-only limits. Inspection is adequate proof for these maintenance/copy corrections; do not add tests that mirror comments.

CR1-15 has independent subclaims with distinct dispositions:

- **Tags/copy/docs:** planned mechanical changes above, no supported behavior removed.
- **RPC spelling:** proposed accepted naming exception for existing `code.language.snippets` pending user choice. Compatibility rules say accepted wire names remain accepted; being on an unmerged PR is not a stated exception. Keep this item open until the disposition is authorized. Alternative: add `get_snippets` schemas, corresponding responses, one shared handler, permission entries and a new capability gate while retaining tagged legacy handling. Estimate prod +45–90/−5–15, tests +60–110 plus generated validators; no request fallback. Revisit the exception during an intentional RPC migration.
- **Explicit `.web` imports / L2:** proposed deferral, currently reachable only from web-specific entry points. Dropping the suffix needs resolver/typecheck proof; the app does not explicitly configure TypeScript platform module suffixes. Do not add empty native implementations merely to change an import spelling. Revisit when shared/native callers are introduced. Validate native bundle isolation if changed. L2 has no current P; S-if-unguarded S1.
- **Different context menus by file type:** rejected as a defect. Supported language actions intentionally replace the menu only when available; unsupported files preserve browser behavior. No inspected rule requires identical menus. A uniform editor menu remains a separate product proposal.

These are bounded choices; no silent protocol removal or capability narrowing. This plan's estimates exclude the optional compatible RPC migration. No other translations are maintained.

### FP11 — Prove the real call paths once

CR1's direct session tests do not prove dispatch/correlation, and packaging string checks do not prove startup. Use the existing isolated daemon helper and real DaemonClient on an ephemeral port. Exercise sync → query → snippets → cancel through WebSocket messages and assert their correlated public results, including error and cancellation after request entry. Use the ordinary authorized harness; add no provider-auth probes or environment-dependent skips. Reuse FP1's harmless sentinel fixture and FP7's real runtime recovery checks rather than duplicating their infrastructure.

For browser proof extend `packages/app/e2e/browser/code-language.spec.ts`, with consistent cold-start timeout. Replace rederived font/gutter constants with an observational production-owned semantic geometry seam (or existing accessible geometry) mapping path/side/line/character to a rendered rectangle. It must not introduce alternate interaction/rendering behavior. FP2–FP5/FP9 supply scenarios and assertions; FP11 owns shared fixture/seam cost only.

Replace the packaging `toBeDefined()` assertion with a meaningful packaging contract check, and separately exercise hover/definition using a packaged app's actual bundled daemon/runtime in isolated state. Confirm runtime files exist under the real unpacked artifact and that results complete; config-text assertions alone cannot close the packaged-launch gap. Do not restart the production daemon or reuse its port/home. The exact artifact invocation depends on the built platform and must be recorded when performed; no packaged result is claimed now.

Alternative: retain direct unit/session tests and manually inspect dispatch/config, with negligible production changes. This leaves the reported transport and packaged-execution obligations unproved and cannot establish release readiness. Avoid importing desktop launch helpers into the server simply to deduplicate an asar regex; the layering/runtime consequences need separate evidence.

**Required execution gates after implementation:** establish a baseline, then `npm run typecheck`, `npm run lint`, and format through npm scripts. Build owning workspace declarations before diagnosing cross-package failures (`npm run build:client` or `npm run build:server` as applicable). Run only changed/new targeted test files, one at a time from their workspace: `npx vitest run <file> --bail=1`. Never run a workspace/full suite locally. Browser: `npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/code-language.spec.ts`. Desktop has a separate `packages/desktop/e2e` test directory: add a targeted spec there using its existing fixture conventions, then run `npm run test:e2e:renderer --workspace=@getpaseo/desktop -- code-language.spec.ts`. That desktop spec does not exist yet; passing the app spec's name alone to the current desktop configuration would find no test. Renderer coverage also does not replace the actual packaged-runtime check above. Record missing prerequisites rather than substituting unit coverage. Format the final changed set via `npm run format:files -- <paths>`; run `npm run format` before any authorized commit.

Fresh read-only verifiers assess each integrated guarantee against the actual diff and proof, independently of its fixer. P1s require red/green evidence at the stated boundary. A verifier must inspect neighboring entry points and confirm the maintenance cost matches the selected option. Missing packaged/platform/performance evidence remains a gap, not closure.

### Evidence-backed rejections and proposed residuals

**D1 / CR1-8 (historical S2/F2 → P2): rejected as reported.** The actual path is `use-actions.web.ts` → workspace file opener → FilePane → `resolveFilePreviewReadTarget()` → `useLiveFile` with its selected cwd. `packages/app/src/file-explorer/preview-target.ts:60` uses the filesystem/drive root for absolute targets outside the literal workspace root. `file-pane/pane.tsx:244` consumes it and passes that cwd at :266. Existing `preview-target.test.ts` covers external POSIX/Windows paths. Thus `/real/repo/lib.ts` returned for `/linked-repo` is read against `/`, not `/linked-repo`; external linked declarations are likewise supported. No general containment change is justified. A symlink F12 browser scenario remains useful neighboring proof in FP11, but has not run. Root independently checked this counterexample.

**D2 / CR1-11 (historical S2/F3 → P3): rejected as an introduced regression.** Base `resolveCheckoutDiffRefs` already uses `<base> HEAD` for branch comparison. `isUnbornHeadDiffError` at `checkout-git.ts:658` matches `--name-status HEAD`, the uncommitted case; the fallback changes only baseRef and would retain unresolved targetRef HEAD. Moving `rev-parse` into that catch does not make its error match. The new call moves the failure earlier in a previously failing branch-mode workflow; uncommitted unborn-HEAD support has no targetRef and remains unchanged. Root compared base and candidate source. No executable before/after repro ran; adding branch comparison before a target commit exists is a separate feature decision.

**D3 / L1 (no current P; S-if-unguarded S1): proposed deferred latent hazard, not accepted yet.** Connected-client file authority and existing preview targeting permit external files. Root-only containment or extension filtering in snippets would break supported declarations without establishing a new security boundary. Revisit when workspace-scoped grants or connected-client read restrictions are introduced; include query pre/post reads, snippets and diff capture in that resource-enforcement inventory. A regular-file read boundary preserving current authority is an alternative (prod +50–100/−15–35; tests +60–110), but requires a coherent size/symlink/content policy. A session-returned-path allowlist adds lifetime state while the same client may already preview arbitrary files; not selected on current evidence.

**CR1-6 disk-scan residual:** proposed deferral as described in FP6, pending before/after measurement. Keeping freshness checks is not accepting stale navigation. Revisit if measurements show the retained work dominates refresh latency; there is no performance budget supplied by the user to invent here.

**Other residual risks:** Unbounded references remain an unmeasured risk, not a proved large-project failure. FP5/FP11 should measure a large reference fixture before proposing pagination or caps; narrowing existing result schemas is not permitted. Packaged launch and Windows path/cleanup are explicit FP11/FP7 proof obligations. macOS planning does not satisfy Windows/Linux/iOS/Android evidence. `package-lock.json` remains outside the prior detailed review; this plan changes no dependencies and does not claim to audit it.

### Coverage of unnamed review observations

| CR1 observation                                           | Assigned plan / disposition                                                                                                                                       |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Failure/retry/stale/open-current lack behavioral tests    | FP3, through action owner and real browser                                                                                                                        |
| Cancellation occurs before a server ever starts           | FP7 observes in-flight entry; FP11 verifies wire routing                                                                                                          |
| Four RPC dispatch paths untested                          | FP11                                                                                                                                                              |
| Crash recovery untested                                   | FP7                                                                                                                                                               |
| Windows cleanup races live child                          | FP7 shutdown ownership + retries; platform execution remains required                                                                                             |
| Windowed list, arrows, short viewport and virtual ARIA    | FP5                                                                                                                                                               |
| Diff browser test rederives geometry                      | FP11 shared observational seam                                                                                                                                    |
| Packaging weak assertion / packaged spawn unproved        | FP11                                                                                                                                                              |
| Second browser test cold-start timeout                    | FP11                                                                                                                                                              |
| No performance measurements                               | FP4 pointer, FP5 snippets, FP6 diff/notifications, FP7 runtime demand                                                                                             |
| Optional collapse of snapshot checks                      | FP8 rejects collapse; shares actual coordinate convention                                                                                                         |
| Optional per-path instead of workspace revision counter   | Proposed follow-up only: changes to imported dependencies can invalidate another file's answer; no dependency-aware invalidation design or measured need supplied |
| Optional shared picker / operation-specific presentations | FP5 / FP3                                                                                                                                                         |
| Optional generic Electron launcher/asar helper reuse      | Proposed follow-up pending packaged evidence; do not invert server→desktop dependency layering                                                                    |

### Actual work and verification in this planning round

Three planners inspected source independently; root verified both rejection counterexamples and the primary action/navigation paths. No product/test/config source edits, test runs, UI runs, benchmarks, builds or commits were performed during planning. Only this ledger and a pointer in CR1 are added/updated. Required record-change checks are recorded below after execution; they do not verify the proposed fixes.

- `npm run typecheck` — exit 0, all workspaces passed. Its protocol pretypecheck regenerated validators; no tracked content changed. Raw output: `/tmp/pr3-planning-typecheck.log`.
- `npm run lint` — exit 0, 0 warnings and 0 errors across 4,211 files. Raw output: `/tmp/pr3-planning-lint.log`.
- `npm run format:files -- findings/FIXES-PR3.md findings/CR1.md` — exit 0.
- `git status --short` after checks — only `?? findings/`; reviewed product candidate remains unchanged.
