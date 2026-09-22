# Fix plans for chilly-panther

## Authorized scope — minimize ongoing fork maintenance

**Updated:** 2026-09-22. **Mode:** One authorized implementation round. The user approved the reduced scope with “ok, implement” after reviewing its limits and LOC estimates. This supersedes the earlier recommendation to implement all six defaults. ROUND-3 records implementation and verification against the original candidate.

| Plan | Recommendation                                                    | Reason and scope                                                                                                                                                                                                                                          | Finding rating                                                           |
| ---- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| FP1  | Implement A.                                                      | Repair the cache schema and type its writer. Repeatable data-reading failure, a small correction, and fewer chances for future schema drift.                                                                                                              | CR1-1, S2/F2 → P2                                                        |
| FP2  | Leave existing translations alone.                                | No demonstrated usage defect or ongoing parity obligation. Deleting working strings adds churn without improving this user's workflow. Apply the English-only rule to future authoring.                                                                   | CR1-2, current S3/F2 → P3; historical S2/F2 → P2                         |
| FP3  | Implement bounded A.                                              | Preserve the actual source file through existing path normalization. Prevent opening/editing another checkout's same-named file. Handle unsupported outside directories at that same boundary; do not introduce workspace-selection or routing machinery. | CR1-3, S2/F2 → P2                                                        |
| FP4  | Do not implement batching now.                                    | Process fanout is real, but its impact on this user's workload has not been measured. Changing the shared Git runner and adding a batch parser is too much continuing machinery for the current evidence.                                                 | CR1-4, S2/F2 → P2                                                        |
| FP5  | Make the copy correction only.                                    | Host-neutral English wording and the zero-count form fix the claim without changing state or selectors. Update existing assertions as needed; no new wording-only test suite.                                                                             | CR1-5, S3/F2 → P3                                                        |
| FP6  | Implement B's settings and status wiring; omit automatic retries. | Use existing config notifications so toggles work during a run, and publish helper loss accurately. This corrects ordinary controls and misleading status without adding another timer/backoff lifecycle.                                                 | CR1-6, current S2/F2 → P2 (frequency provisional); historical S2/F3 → P3 |

The approved work is FP1-A, bounded FP3-A, FP5's copy-only correction, and FP6-B's settings/status wiring. FP2 and FP4 receive no product edits. Implementation, commits, and pushing this branch are authorized by the later “commit and push” request.

The remaining helper-exit limitation is explicit: without automatic retry, a busy run can stay unprotected until a later agent/configuration event or a setting toggle retries acquisition. The user approved this scope after that limitation was stated. The original symptom must not be marked verified-closed. Git refresh cost also remains unresolved; deferring its implementation is not a claim that it is fast enough.

## ROUND-3 — Implement the reduced scope

**Authorization:** User, 2026-09-22: “ok, implement,” referring to the four-fix summary immediately above. The summary explicitly excluded translation cleanup, Git batching/cache redesign, automatic sleep-helper recovery, and automatic workspace switching. The later “commit and push” request authorizes committing and pushing this same verified scope. No release or main-daemon restart is included.

**Candidate and baseline:** HEAD remains 819cee69557ef41edce0652c06b09e34babf4c82. Product files were clean at round start; only the existing findings records were untracked. Root `npm run typecheck` and `npm run lint` both passed before implementation; lint reported zero warnings/errors. Logs: /tmp/chilly-fixes-baseline-typecheck.log and /tmp/chilly-fixes-baseline-lint.log.

**Ownership:** Three fixers own cache, file paths, and sleep runtime. Root owns shared English resources, existing indicator test updates, subject documentation, integrated gates, and this ledger. Fresh read-only reviewers verify the changed guarantees outside their fixer threads. No full test suite is run.

**Outcome:** All four selected fixes are implemented. FP1, FP3, and FP5 are verified-closed within the evidence limits below. FP6-B's settings/status guarantees are verified; the original automatic-recovery consequence remains accepted residual risk. The verified fixes are committed; see the commit association below.

### Actual changes and size

| Plan      | Implemented change                                                                                                                                                                 | Production added / removed | Tests/support added / removed |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------- |
| FP1       | Accept persisted icon/metadata with existing schemas; type the snapshot writer.                                                                                                    | +4 / −1                    | +77 / −0                      |
| FP3       | Keep files anchored to their source checkout; use displayed workspace ownership for directories and render a dismissible error for unsupported paths. Includes two English errors. | +77 / −40                  | +124 / −10                    |
| FP5       | Host-neutral singular/plural/zero English wording. Repair existing browser-test setup so its assertions execute.                                                                   | +3 / −2                    | +16 / −6                      |
| FP6-B     | Subscribe to committed config and backend state; apply toggles immediately, publish helper loss, and dispose subscriptions.                                                        | +30 / −5                   | +154 / −8                     |
| **Total** | Existing modules and harnesses; no new production files.                                                                                                                           | **+114 / −48**             | **+371 / −24**                |

Subject documentation adds 3 lines and removes 1 in docs/agent-lifecycle.md. Findings records and temporary artifacts are excluded. Production additions are within the +80–150 estimate; 48 removed lines exceed the estimated 15–40. Tests/support are within the +250–420 estimate. Removing obsolete path-normalization branches accounts for most deleted production lines.

No new protocol, routing state, dependency, Git batching, or retry timer was introduced. File-path errors add one local UI state value, using existing Alert/Button components. Sleep adds one listener set to the existing backend and uses the config store's existing committed-change subscription. The test harness needed one Coffee icon export and the repository's existing React-global setup; these are test-only corrections, not product behavior changes.

### Executed verification

| Check                                                                                                                                                             | Actual result                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App: `npx vitest run src/runtime/replica-cache/index.test.ts --project unit --bail=1`                                                                             | **26 passed.** New public roundtrip regression first failed because two valid agents disappeared, then passed after the correction.                                                                                                                     |
| App: `npx vitest run src/assistant-file-links/parse.test.ts --project unit --bail=1`                                                                              | **52 passed.** Collision regression first reproduced source B becoming a relative filename, then passed. Adjacent cases cover nested roots, directories, tool paths, file URLs, Windows paths, line references, home-relative paths, and missing roots. |
| Server: `npx vitest run src/server/sleep-inhibitor/index.test.ts --bail=1`                                                                                        | **15 passed.** Config-only toggling and helper-loss publication each failed before their corrections, then passed.                                                                                                                                      |
| Server: `npx vitest run src/server/sleep-inhibitor/backend.test.ts --bail=1`                                                                                      | **9 passed.** Process notifications, stale/duplicate events, support loss, and unsubscribe behavior covered.                                                                                                                                            |
| App: `PLAYWRIGHT_BROWSERS_PATH=/tmp/chilly-fixes-browsers npx vitest run src/components/desktop/keep-awake-indicator.browser.test.tsx --project browser --bail=1` | **4 passed in Chromium.** Active plural/singular/zero labels and final disappearance. Log: /tmp/chilly-fixes-indicator.log.                                                                                                                             |
| Root: `npm run typecheck`                                                                                                                                         | **Passed** on final product/test content. Log: /tmp/chilly-fixes-typecheck.log.                                                                                                                                                                         |
| Root: `npm run lint`                                                                                                                                              | **Passed, zero warnings/errors** on final content. Log: /tmp/chilly-fixes-lint.log.                                                                                                                                                                     |
| Root: `npm run format:check:files -- <all 13 changed product/test/doc files>`                                                                                     | **Passed.** Exact file arguments captured in /tmp/chilly-fixes-format.log. Each changed file was formatted using npm scripts first.                                                                                                                     |
| `git diff --check`                                                                                                                                                | **Passed.**                                                                                                                                                                                                                                             |

The first integrated lint run found an inline dismiss callback and excess component complexity introduced by FP3. A stable callback and removal of redundant optional handling on required context.cwd resolved both without suppression or helper behavior changes. Final full gates were rerun afterward. Browser execution initially hit sandbox binding restrictions and a missing Chromium executable. The temporary browser download stalled while extracting; its completed archive was extracted with unzip after stopping only this round's installer processes. The first executing browser attempts then exposed the missing icon export and React global. The final browser run passed after those bounded harness corrections. No full test suite, main-daemon operation, or real OS suspend was run.

### Fresh closure evidence

- **FP1 / CR1-1, S2/F2 → P2:** verify_cache independently checked baseline/mutation writers, direct/directory readers, normalization, and scoped corruption repair. It approved bounded closure and the local schema/writer maintenance tradeoff. Actual proof uses MemoryStorage; live IndexedDB/SQLite and offline UI were not exercised. Already-deleted rows still require reconnection.
- **FP3 / CR1-3, S2/F2 → P2:** verify_paths independently traced markdown/tool links through all file-open dispositions, preview resolution, and the editor's writeFile cwd/path. It confirmed outside-directory rejection occurs before reads/mutations, same/nested directory ownership, and compact/desktop selection behavior. It approved bounded closure of the source identity correction. No live cross-checkout browser/Electron or native action was run: rendered error, compact dismissal, and edit destination have source-inspection evidence. Adding a new background-activity seeding API solely for UI testing was outside this bounded patch.
- **FP5 / CR1-5, S3/F2 → P3:** verify_sleep inspected shared accessibility/tooltip wording, unchanged aggregate selectors, final harness changes, and the actual 4/4 browser log. It approved closure for the English wording guarantee. The browser test asserts accessibility labels; visible tooltip wording also uses that same label in the component.
- **FP6-B / CR1-6, current S2/F2 → P2 provisional; historical S2/F3 → P3:** verify_sleep checked post-commit config notifications, backend process identity/error paths, subscription cleanup, bootstrap/broadcast, initial/resumed client state, parsing/session storage, and disconnect clearing. It approved the chosen settings/status guarantee and maintenance cost. Physical OS sleep and actual helper termination through a connected app were not exercised. No automatic recovery is claimed; the original lost-protection consequence remains accepted residual risk under the user's narrowed authorization.

Fresh reviewers reused unchanged green tests instead of rerunning them. All reviewer conditions concerning the final repository gates are now satisfied.

**Tested snapshot:** HEAD 819cee69557ef41edce0652c06b09e34babf4c82 plus `/tmp/chilly-fixes-round3.patch` (`git diff --binary HEAD`), SHA-256 **291a3ebc149131eacb4aed6b974070e22da44ba0d933458541e669550c2d3f43**. It includes every changed tracked product/test/doc file; findings records are untracked and excluded. No product/test/doc edits followed that snapshot. The same tested content is committed; the commit association below preserves the verification link.

### Commit association

The user subsequently requested “commit and push.” The unchanged verified content is split into three commits:

- FP1: c3e1edd11f5eb3036b2ed7f2e721cb3b6ff5301a — Fix cached agent metadata round trips.
- FP3: 0f0ba1f1da8fe32e51cb9594c7456a5194d3aaa9 — Preserve source checkout paths in agent activity.
- FP5/FP6-B: 59ed3d0cb21357bb1920b588f0fa600584a33c1a — Apply sleep settings and report inhibitor state changes.

Root `npm run format` passed before committing without changing the tested content. Every product commit's pre-commit formatting, lint, and full typecheck hooks passed. The cumulative binary diff from 819cee69557ef41edce0652c06b09e34babf4c82 through 59ed3d0cb21357bb1920b588f0fa600584a33c1a has SHA-256 291a3ebc149131eacb4aed6b974070e22da44ba0d933458541e669550c2d3f43, exactly matching the tested snapshot. A following records-only commit includes CR1 and this ledger. The authorized push target is origin/chilly-panther.

## ROUND-2 — Reassess cost against the personal-fork constraint

**Why the recommendation changed:** The earlier plan optimized for completing each correction and its edge-case coverage. The user now explicitly prioritizes maintenance burden and minimal deviation. A real defect does not make every proposed correction worth carrying. Existing translations need no cleanup, and neither a shared Git batching API nor a retry controller is justified solely by the present review evidence.

**Keep the implementation bounded:** FP1 should change the stored shape and writer typing, with a focused round-trip regression. FP3 should retain source identity in the existing shared path boundary, with a collision regression and adjacent directory ownership checks; a file-only wrapper that leaves directory state inconsistent remains incomplete. FP5 needs only resource changes and necessary existing-test updates. FP6-B needs committed-config and backend-state notifications, immediate toggle behavior, accurate publication, and subscription teardown. It should add no retry timer or generic recovery abstraction.

**Verification should follow the changes:** Reuse the existing test harnesses and path cases. Add focused proof of the cache round trip, correct source-file opening, outside-directory handling, config-only toggling, helper-loss publication, and disposal. Do not build the full speculative edge-case matrix from ROUND-1 by default. Run the required repository checks after implementation; use fresh verification for the changed guarantees, with physical OS sleep and untested platforms disclosed as limits.

**When to revisit omitted work:** Measure Git command counts and refresh delay if a representative workspace exhibits lag, or before a known large bulk-change workflow. If a fix is warranted, first compare limiting expensive categorization through its existing fallback with batching; the former preserves overall line totals but reduces breakdown detail and requires that explicit behavior choice. Revisit automatic sleep-helper recovery if it fails during an actual run or uninterrupted recovery becomes an explicit requirement. Revisit locale files only for an actual copy defect or a requested localization change.

**Status:** This is a recommendation, not a recorded acceptance of residual defects or an implementation result. No finding is closed. Product/test files are unchanged; only this ledger was revised.

## Scope and current status

- Branch: chilly-panther. GitHub lookup found no pull request for infi-pc:chilly-panther; this branch ledger is the status owner.
- Candidate: 819cee69557ef41edce0652c06b09e34babf4c82.
- Resolved default: origin/HEAD → origin/main, at f22a37e613e965c8ebc02e1f5565e21fd72eaf2f.
- Review base: fdf3b4b47f1aae0f4f44e8c97210f8b907159edb. Full candidate range: fdf3b4b47f1aae0f4f44e8c97210f8b907159edb..819cee69557ef41edce0652c06b09e34babf4c82.
- At planning start, product/test/config/doc content matched the reviewed commit. The only untracked file was findings/CR1.md, SHA-256 7a85f237e2fc8284b96406f85c527503f4a39c7a71d5295792395815bba9c5fb before its ledger pointer was appended.
- Worker capacity: root plus three workers; initial planners were read-only. ROUND-3 uses fixers followed by fresh reviewers.
- Authorization: initial skill invocation requested planning. The later “ok, implement” authorizes the reduced ROUND-3 scope; “commit and push” authorizes committing and pushing those changes and these records.

| Finding | Historical rating / gate  | Current rating / gate                            | Status                                           | Plan | Fixing commit |
| ------- | ------------------------- | ------------------------------------------------ | ------------------------------------------------ | ---- | ------------- |
| CR1-1   | S2/F2 → P2 / non_blocking | S2/F2 → P2 / non_blocking                        | verified-closed; cache boundary                  | FP1  | c3e1edd11     |
| CR1-2   | S2/F2 → P2 / blocks       | S3/F2 → P3 / non_blocking                        | rejected; no cleanup needed                      | FP2  | —             |
| CR1-3   | S2/F2 → P2 / non_blocking | S2/F2 → P2 / non_blocking                        | verified-closed; UI proof limit recorded         | FP3  | 0f0ba1f1d     |
| CR1-4   | S2/F2 → P2 / non_blocking | S2/F2 → P2 / non_blocking                        | deferred; representative lag is revisit trigger  | FP4  | —             |
| CR1-5   | S3/F2 → P3 / non_blocking | S3/F2 → P3 / non_blocking                        | verified-closed; English wording                 | FP5  | 59ed3d0cb     |
| CR1-6   | S2/F3 → P3 / non_blocking | S2/F2 → P2 / non_blocking; frequency provisional | settings/status verified; recovery accepted-risk | FP6  | 59ed3d0cb     |

All six inputs remain recorded against the original candidate; ROUND-3 is the first implementation attempt. CR1-2's cleanup recommendation is rejected because no runtime defect or continuing translation-parity obligation was demonstrated. CR1-4 is deferred under the approved reduced scope until representative refresh lag or a known large bulk-change workflow warrants measurement. CR1-6's automatic-recovery limitation is accepted for this scope, to revisit after an observed mid-run failure or an explicit uninterrupted-protection requirement. These dispositions are authorized by the user's approval of the summary that stated them. No remaining finding has a blocking gate; verification below determines the bounded closure claims.

## ROUND-1 — Plan only (historical alternatives)

### Original decision sheet

**Mode:** Plan-only. **Date:** 2026-09-22. **Input:** [CR1](CR1.md), reviewed on 2026-09-17. No implementation or closure verification has run.

| Plan | Problem → recommended default A                                                                                                                                                                                    | Maintenance change                                                                                     | Decision and coverage                                                              | Size context: added / removed LOC                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| FP1  | **Cached agents disappear after reopening.** Add the missing persisted fields and type the snapshot at its construction site.                                                                                      | Keeps strict validation; catches future writer/schema drift locally.                                   | Mechanical; CR1-1, S2/F2 → P2                                                      | Production +4–8 / −1–2; tests +65–95 / −0            |
| FP2  | **Branch copy conflicts with the policy introduced alongside it.** Remove only those branch-menu translations, retaining translations written before the rule.                                                     | Removes 88 translated values; uses existing English fallback.                                          | Judgment at policy cutoff; CR1-2, current S3/F2 → P3; historical S2/F2 → P2        | Production +0 / −104; tests +0 / −0                  |
| FP3  | **Activity links can open the wrong checkout.** Preserve source file paths at the shared navigation boundary; explain that directories outside the displayed workspace must be opened from their source workspace. | Keeps source paths independent of the displayed root; adds no workspace selection state.               | Judgment; CR1-3, S2/F2 → P2                                                        | Production +40–75 / −8–18; tests +160–280 / −0–10    |
| FP4  | **Large dirty workspaces queue hundreds of Git processes.** Read source blobs in bounded batches while retaining categorized statistics.                                                                           | Adds bounded input and byte handling to the existing Git runner; removes bulk per-file process fanout. | Judgment; CR1-4, S2/F2 → P2                                                        | Production +190–290 / −25–50; tests +220–340 / −0–15 |
| FP5  | **The global indicator claims remote protection is local.** Use host-neutral English wording, including the zero-agent release delay.                                                                              | Retains the aggregate selectors and count; uses existing pluralization.                                | Mechanical; CR1-5, S3/F2 → P3                                                      | Production +3 / −2; tests +25–50 / −5–10             |
| FP6  | **Sleep protection misses helper failures and setting changes.** Reconcile agent, setting, and helper changes in the existing runtime, with bounded retries.                                                       | Adds backend/config subscriptions and one retry timer under one owner.                                 | Judgment; CR1-6, current S2/F2 → P2 (frequency provisional); historical S2/F3 → P3 | Production +90–140 / −15–30; tests +180–270 / −10–25 |

Original full-portfolio estimate, not the current recommendation: production **+327–516 / −155–206**, approximately **558–823 touched LOC**; tests **+650–1,035 / −15–60**, approximately **730–1,165 touched LOC**. These are planning ranges, excluding records and generated output. Shared files are coordinated below; shared test infrastructure is included once in its owning plan.

### Guarantees and limits

Preserve readable cached agents, source-file identity during activity inspection, categorized change statistics, truthful aggregate sleep status, and the existing host-controlled protection of non-internal initializing/running agents. Keep English as the maintained copy source. Use current cross-platform path handling and existing workspace ownership; never infer a workspace ID from cwd.

The personal fork favors small, durable ownership boundaries. No protocol changes, new platform promises, removed locale support, general retry framework, or asynchronous statistics publication are proposed. Sleep protection remains limited by OS support and cannot prevent lid-close suspend. Physical suspend behavior and user latency are not established by source inspection.

### FP1 — Keep cached agents readable

**Covers:** CR1-1, S2/F2 → P2.

**Problem → default A:** New agent rows containing icon or responseMetadata are rejected and deleted on the next cache read, leaving offline startup without those agents until reconnect. Add optional icon and the existing AgentResponseMetadataSchema to StoredAgentSnapshotSchema, and contextually type the object built by serializeAgent as StoredAgent["snapshot"]. This repairs unread rows and makes future extra fields fail at the writer's construction site. Already-deleted rows still need reconnect.

**Planning detail:** ReplicaCache owns the intentionally reduced stored shape and strict validation. Agent registration assigns metadata without requiring a user-selected icon. Both mutation commits and baseline replacement share serialization; readAgent and directory reads share the strict schema. Corrupt-row handling deletes the row and repairs its entity checkpoint. The agent normalizer and directory-sync consumers preserve valid fields and cannot reconstruct rejected rows. These producer, consumer, sibling-read, and repair paths were inspected.

**Trade-offs:** Reuse protocol metadata validation while preserving cache-specific date and collection constraints. Callers keep submitting normalized agents; no new flags, migrations, storage adapters, or state are introduced. Default size: production +4–8 / −1–2, 6–14 touched; tests +65–95 / −0, 65–100 touched.

**Alternative B:** Derive the stored snapshot from a pick of AgentSnapshotPayloadSchema, override cache-specific fields, and retain strictness plus writer typing. This shares more declarations but couples the cache to wire-schema changes and still needs an explicit persisted subset. Production +35–60 / −35–50, 70–110 touched; tests +65–95 / −0, 65–100 touched. The larger regression surface covers every stored agent field; the default is sufficient for the demonstrated drift.

**Proof, proposed:** Through public ReplicaCache methods and the existing MemoryStorage adapter, write via commitDirectoryMutations and replaceDirectoryBaseline, construct a new reader, and read through readAgent and readDirectory. Cover icon alone, metadata alone, both, legacy absence, valid checkpoint retention, and scoped repair for malformed metadata. The targeted test should first demonstrate the loss, then pass with the fix. Existing adapter behavior is unchanged; no browser/SQLite storage claim is made by the memory-adapter test.

**Avoid:** Relaxing the whole strict schema or omitting the new fields from persisted state. **Decision:** A, mechanical. Independent of the other plans.

### FP2 — Limit policy cleanup to the affected branch strings

**Covers:** CR1-2, historical S2/F2 → P2 / blocks; current S3/F2 → P3 / non_blocking.

**Problem → default A:** The policy-introducing commit also added branch-menu translations. Remove only workspace.header.branches from ar, es, fr, ja, ko, pt-BR, ru, and zh-CN. Those branch actions and accessibility labels will intentionally use English fallback. Keep translations added before the policy and retain the partial-resource typing changes.

**Reconciliation evidence:** Commits 80c69f95c and 41b31a3dd added change-statistics, PR, and script translations under the previous translation/parity rules. Commit fae603ccb introduced the English-only instruction, fallback tests, partial-resource typing, and 11 branch strings in each of eight locales. Later commits modify only English resources. Current i18next configuration and resource tests permit incomplete locales. Thus the original report overstated required upkeep and retroactive removal; no broken translated copy or meaningful workflow failure is demonstrated. The remaining same-commit inconsistency warrants the lower rating and removal of the blocking gate. Frequency for this authoring-policy case is provisional.

**Trade-offs:** English resources and existing fallback own the result; no caller, state, or dependency changes. Delete eight 13-line sections: production +0 / −104, 104 touched; tests +0 / −0. This removes 88 translated values.

**Alternative B:** Retain those branch strings as part of the baseline when the policy was adopted, and apply English-only authoring prospectively. Production/tests +0 / −0. This requires judgment about the same-commit cutoff, but adds no continuing parity obligation. It is not acceptance of a demonstrated runtime defect. The default chooses the narrow cleanup to align that commit's new copy with its own instruction.

**Proof, proposed:** Inspect the exact resulting diff and use the existing resource tests for nested fallback and interpolation. No test that merely asserts the absence of source strings is needed. Commit chronology was checked during planning; resource tests were not run.

**Avoid:** Reverting all eight locale files to the review base, removing locale support, or undoing satisfies TranslationResources. **Decision:** A, judgment about the same-commit policy cutoff. It does not touch en.ts or overlap FP5's wording changes.

### FP3 — Keep paths tied to their source checkout

**Covers:** CR1-3, S2/F2 → P2, including the directory-link sibling at the same ownership boundary.

**Problem → default A:** While inspecting B's activity inside workspace A, file links can open A's same-named file. Directory links can also combine B's listing with A's Explorer state. Correct the shared stream handoff: resolve against the conversation's source cwd first, then make a file path relative only if it lies inside the actual destination workspace root. Preserve absolute paths for outside files using existing FilePane support.

Obtain the destination root from useWorkspaceDirectory while keeping markdown parsing and lookup rooted at the source cwd. Keep line ranges and main/preferred/side disposition. Use the destination root for Explorer reads and ownership. For directories outside that root, show an English explanation to open the folder from its source workspace, and do not fetch or mutate the current Explorer.

**Supported-behavior choice:** Files remain inspectable in the current workspace, including existing external-file editing behavior. Cross-root directory navigation is explicitly restricted because today's Files panel cannot represent another root. Same-root and nested-source directory behavior is preserved. This restriction makes the default a judgment choice.

**Planning detail:** Markdown/lookup producers already anchor source paths; AgentStreamView.handleInlinePathPress makes them source-relative before handing them to the destination pane. Tool details converge on that same handler. Directory links branch before the file callback, so a BackgroundThreadPanel file-only wrapper is incomplete. FilePane and its preview resolver deliberately support outside absolute files, including editing. FilesPanel derives its root from pane workspace identity; passing another checkout does not change its desktop root. List opens, retry attempts, restored thread tabs, and native activity shells converge on the shared handler.

No snapshot/conversation already yields a loading/unavailable surface. Unanchorable relative paths must fail visibly instead of falling back to the current checkout. When the destination root is unavailable, preserve resolvable absolute file identity for the existing file-panel unavailable state; directory actions must fail without Explorer mutation. Preserve home-relative files for the existing preview resolver.

**Trade-offs:** The existing normalization/handoff boundary owns source-to-destination conversion. Ordinary same-root callers retain their behavior, and callers no longer need to assume conversation cwd equals pane root. No source-workspace fields or callback flags are added. Production +40–75 / −8–18, 55–100 touched; tests +160–280 / −0–10, 180–310 touched, including the targeted UI fixture/spec.

**Alternative B:** Open the activity in its recorded source workspace through navigateToWorkspace. Centralize list, attempt, and restored-tab routing. This preserves source Explorer navigation but switches the user's workspace and needs a policy for missing/archived IDs, unowned requests, and conversations with several requests. Cwd is not an authoritative workspace selector. Keep unavailable history inspectable and show an explicit source-unavailable state for path actions. Production +90–160 / −15–35, 120–205 touched; tests +210–340 / −0–15, 240–380 touched. It adds route/history/native-shell proof and continuing source-workspace selection ownership.

**Proof, proposed:** Cover the real parse/lookup → normalization → preview-target path for colliding filenames in two roots, markdown, tool paths, file URLs, Windows paths, same/nested roots, home-relative files, line ranges, dispositions, missing roots, and directory rejection before mutation. Add one real-browser scenario with an isolated daemon: open B's helper from A, show B's distinctive file content while A remains selected, and verify edits affect B only. Check the visible outside-directory explanation, unchanged A tree, same-workspace opening, and compact overlay dismissal. Inspect retry and restored-thread entry points; native compact/wide behavior remains a separate evidence limit until exercised.

**Avoid:** Changing only list navigation, assigning a source workspace ID without moving its shell, or routing an absolute directory into the current Files panel. **Decision:** A, judgment. Serialize en.ts edits with FP5.

### FP4 — Batch source reads for categorized statistics

**Covers:** CR1-4, S2/F2 → P2.

**Problem → default A:** Refreshing over 256 changed tracked source files eligible for content parsing can repeatedly launch a process for each uncached old blob. Batch discovery and content reads while preserving the current statistics and limits.

**Planning detail:** The inspected path is workspace worktree refresh → getCheckoutWorktreeState → forced shortstat → readComparisonBreakdown → addFileBreakdowns → readContent. Structural and moved-ref refreshes also reach classification. The 500-file analysis cap exceeds the 256-entry/8 MiB cache. The default global scheduler admits 64 process starts per second and eight concurrently. With an empty scheduler, 300 missed blobs require four subsequent throttle windows and 500 require seven, even ignoring execution time. These are dispatch bounds, not measured latency. Docs/tests and other path-classified categories may avoid full-content reads; the reach is eligible source files.

Default implementation direction:

1. Discover selected blobs by ref using NUL-delimited ls-tree output, including sizes, with arguments bounded by byte size.
2. Read object IDs through cat-file --batch and parse size-framed bytes before decoding each blob. IDs avoid newline ambiguity without requiring a newer Git -Z option.
3. Enforce the existing 1 MiB/file and 500-file limits, and an aggregate batch byte limit. Classify and release each batch rather than retaining all possible contents. Preserve renames, deleted/missing blobs, committed targets, skipped categories, and total reconciliation.
4. Extend the existing Git runner narrowly for input and raw output. Preserve admission, tracing, provenance, metrics, output caps, timeouts, process-slot lifetime, and error cleanup. Keep the immutable cache as an optimization whose misses do not cause per-file process fanout.

**Trade-offs:** Change-stat reading owns eligibility and memory; a small internal blob reader owns framing; the existing Git runner owns processes. Its input/raw-output capability must propagate through Comparison.runGit, getRunGitCommand(context), and runRefreshGitCommand with sound types and unchanged text-only contracts. Bulk callers share the correction; an isolated committed-file read need not scan the repository. Production +190–290 / −25–50, 240–380 touched; tests +220–340 / −0–15, 230–370 touched. This introduces byte-framing code but no new publication lifecycle.

**Alternative B, containment:** Resize/reshape the content cache to hold a comparison. Production +20–45 / −10–25, 35–65 touched; tests +70–110 / −0, 70–110 touched. It reduces repeated small warm reads but leaves cold bursts, byte pressure, and competition from other repositories. Choosing it would narrow the guarantee and leave the cold-path consequence open.

**Alternative C:** Publish totals first and enrich asynchronously. Production +100–170 / −10–30, 140–220 touched; tests +160–250 / −0–20, 180–270 touched. It needs generation ownership, cancellation, stale-result rejection, and UI handling for pending breakdowns. It still queues the same processes unless combined with batching, so it does not replace A's process-pressure correction.

**Proof, proposed:** In a real temporary repository, change 300 small eligible TypeScript files and call getCheckoutWorktreeState twice, changing one file between calls. Use existing Git command metrics to assert exact categories/totals and bounded batch commands on cold and repeated refreshes, with no per-file show commands. Cover multiple byte batches, analysis limit, renamed paths with tabs/newlines, Unicode framing, oversized/missing/deleted content, and committed targets. At the runner boundary, cover input EOF/error, truncation, malformed/incomplete frames, process failure, timeout, and release of scheduler slots. Prefer command-count assertions over machine-sensitive wall-clock assertions.

**Avoid:** Calling a larger cache a cold-path fix, bypassing the scheduler, decoding before byte framing, per-file fallback fanout, or unbounded prefetch. **Decision:** A, judgment. One fixer/integration owner must cover the runner ports and all bulk callers. Classification CPU remains unmeasured and outside this correction.

### FP5 — Describe aggregate sleep protection accurately

**Covers:** CR1-5, S3/F2 → P3.

**Problem → default A:** A remote-only inhibitor makes the local global indicator say “this computer” is awake. Change the shared English tooltip/accessibility label to host-neutral copy, preserving its aggregate agent count. Use a zero plural form during release debounce:

- Zero: “Sleep prevention active”
- One: “Sleep prevention active for {{count}} agent”
- Other: “Sleep prevention active for {{count}} agents”

**Planning detail:** Selectors deliberately aggregate every active host; existing tests establish that purpose. Sidebar and collapsed window chrome share the indicator. The runtime can report active=true and agentCount=0 during its ten-second release delay, so count-only working-agent phrasing is insufficient.

**Trade-offs:** Existing translation pluralization owns the zero state. No new selector, host identity join, or component state is needed. Production +3 / −2, 3–5 touched; tests +25–50 / −5–10, 35–65 touched.

**Alternative B:** Show active host names and per-host counts. Production +45–85 / −8–18, 65–110 touched; tests +65–110 / −5–15, 85–140 touched. It adds a host/session projection, rename/removal handling, and multi-host presentation rules. Limiting the indicator to local activity would instead remove existing remote visibility and require local-host identity. Neither expansion is needed for accurate aggregate wording.

**Proof, proposed:** Update the existing real-browser indicator scenario for remote-only activity, multiple active hosts, singular/plural, zero-agent release delay, and clearing the final active host. Assert the visible tooltip and accessible label together. Reuse selector coverage; no new unit test that merely mirrors wording.

**Decision:** A, mechanical. Coordinate en.ts with FP3 and verify with FP6's active/count publication as one sleep integration batch.

### FP6 — Reconcile every input to sleep protection

**Covers:** CR1-6, historical S2/F3 → P3; current S2/F2 → P2 with provisional frequency.

**Problem → default A:** Helper exit/startup errors change backend state without notifying the runtime, so busy runs lose protection and connected clients can retain an active indicator. Changing the setting alone also fails to acquire/release until an agent event arrives. Keep setupSleepInhibitor as the single owner of desired protection and subscribe it to agents, committed configuration, and backend state.

Publish failure state immediately and retry while protection is still needed. Use one timer with capped backoff, initially 1, 2, 4, 8, 16, then 30 seconds. This caps retry rate, not total attempts while busy. Agent events must respect cooldown. Reset when demand ends or the user disables and reenables, not merely because a process was spawned.

**New sibling evidence:** SleepInhibitorOptions accepts only config.get(); evaluation runs at startup and on agent_state. DaemonConfigStore.onChange already publishes committed updates, while the websocket subscriber only broadcasts configuration. The existing immediate-disable test mutates config and emits another running-agent event, masking the missing subscription. Helper errors/exits also fail to publish, although getState reads accurate backend state on reconnect. The broader deterministic setting trigger supports current S2/F2 → P2, but its user prevalence is unknown; the rare-exit historical pair is preserved.

**Lifecycle detail:** Known missing binaries and unsupported platforms remain terminal unsupported states. Retryable startup failures behave consistently whether synchronous or asynchronous. Ignore obsolete-child events, deduplicate error/exit, and distinguish intentional release. Disable cancels recovery and releases immediately; enable acquires during an unchanged busy run. Idle/disposal cancels recovery; disposal unsubscribes all sources, clears both timers, releases the child, and ignores late callbacks. Keep getState observational. Use the existing seams plus a narrow clock adapter for deterministic scheduling.

**Trade-offs:** The backend owns process identity and observed facts; the runtime owns busy/enabled demand, debounce, retry, and broadcasts. Callers construct/dispose one runtime and settings code need not manually poke it. Added state is one retry timer and backoff position. Production +90–140 / −15–30, 150–220 touched; tests +180–270 / −10–25, 220–320 touched. No polling, protocol change, or general retry framework is proposed.

**Alternative B:** Subscribe to backend/config changes and report failure accurately, but retain manual/event-driven recovery without a retry timer. Production +35–65 / −5–15, 60–100 touched; tests +100–160 / −5–15, 130–190 touched; docs +3–6 / −1–3. It fixes stale status and settings application but leaves unexpected helper exit able to expose the ongoing run to sleep. Choosing it requires explicit acceptance of that residual and a revisit trigger such as another observed mid-run loss; the original exit defect would not be verified-closed.

**Proof, proposed:** Wire the real process backend into runtime tests using the injected spawn seam and clock. With an agent remaining busy, emit helper exit and assert immediate inactive publication, matching getState, and recovery without an agent event. Cover retryable and terminal startup errors, repeated rapid failures, agent events during cooldown, and only one timer/child. Change only configuration to prove immediate disable/enable. Exercise idle, disable, disposal, obsolete children, and duplicate error/exit while recovery is pending. Preserve startup adoption, concurrent-agent counts, initializing/internal filtering, and delayed release between turns.

These tests prove controller ownership and publication, not that the OS has granted an inhibitor or that a physical machine cannot suspend.

**Decision:** A, judgment. Integrate backend/runtime/config port and tests together; verify with FP5. No main-daemon restart is part of this plan.

### Execution order and verification plan

FP1, FP2, and FP4 have independent code ownership. FP3 and FP5 both touch English resources, so serialize those edits. Treat FP5/FP6 as one sleep integration batch with one integration owner. After an implementation request, run baseline gates before changes, assign fixers within three worker slots, and use fresh read-only verifiers outside their fixer threads for FP1, FP2, FP3, FP4, and the FP5/FP6 batch.

Run only changed, targeted test files. Proposed commands below assume the listed working directory; new filenames are proposed, not existing test results.

| Plan | Working directory | Targeted command                                                                                                               |
| ---- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| FP1  | packages/app      | npx vitest run src/runtime/replica-cache/index.test.ts --project unit --bail=1                                                 |
| FP2  | packages/app      | npx vitest run src/i18n/resources.test.ts --project unit --bail=1                                                              |
| FP3  | packages/app      | npx vitest run src/assistant-file-links/parse.test.ts --project unit --bail=1                                                  |
| FP3  | packages/app      | npm run test:e2e -- e2e/browser/background-activity-file-links.spec.ts --workers=1 — proposed new spec                         |
| FP4  | packages/server   | npx vitest run src/utils/checkout-git-change-stats.test.ts --bail=1 — proposed new test                                        |
| FP4  | packages/server   | npx vitest run src/git/change-stats/read.test.ts --bail=1                                                                      |
| FP4  | packages/server   | npx vitest run src/utils/run-git-command-input.test.ts --bail=1 — proposed new test, or the exact existing runner test changed |
| FP5  | packages/app      | npx vitest run src/components/desktop/keep-awake-indicator.browser.test.tsx --project browser --bail=1                         |
| FP6  | packages/server   | npx vitest run src/server/sleep-inhibitor/backend.test.ts --bail=1                                                             |
| FP6  | packages/server   | npx vitest run src/server/sleep-inhibitor/index.test.ts --bail=1                                                               |

Root gates: npm run typecheck and npm run lint; format changed files with npm run format:files -- <paths>, then check formatting through the npm script. Run the final gates once on the integrated candidate. Rebuild the owning client/server stack before diagnosing stale generated declaration errors. Never run the full test suite locally or duplicate a targeted run already reported green on unchanged content.

Verifiers need the original finding, current narrowed guarantee, chosen option, candidate snapshot, actual proof results, sibling paths, and maintenance expectations. No finding is closed by a green general gate alone. Record tested content before associating fixing commits; commits are not authorized by this planning invocation.

### ROUND-1 results and choices (superseded by ROUND-2)

- Planning inspection verified the unchanged candidate, report match, PR absence, producer/consumer paths, error paths, tests, and translation commit chronology.
- Prior review reported typecheck, lint, and formatting passing on this same product candidate on 2026-09-17. They were not rerun to estimate these plans and are not fix-closure evidence.
- No product/test changes, test runs, benchmark, UI repro, implementation, or closure verification occurred. Only this ledger and the report pointer were written.
- Record formatting passed with npm run format:check:files -- findings/FIXES-chilly-panther.md findings/CR1.md.
- Each default is recommended, not yet implemented or accepted as an execution decision. No fixing commits exist.
- Judgment choices remain explicit: FP2's policy cutoff; FP3's outside-directory limitation versus workspace switching; FP4's bounded batching versus narrower containment; FP6's retry policy versus accepted manual recovery. The later ROUND-2 recommendation supersedes these defaults.
- Residual verification limits: native activity presentation, physical OS sleep behavior, and measured refresh latency. Missing/archived source-workspace policy is needed only if FP3-B is selected.

Current status lives here; CR1 remains the historical review snapshot.
