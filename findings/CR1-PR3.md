# CR1 — PR #3 "Add TypeScript code intelligence to editors and diffs"

Current status and fix decisions: [FIXES-PR3.md](FIXES-PR3.md). This report remains the historical review snapshot.

**Review date:** 2026-09-17
**Repo:** infi-pc/paseo · **PR:** #3 (open)
**Base:** `f777bc1b38090a427fe64b723e4df6303d31f7d4` (`paseo-customizations`)
**Candidate:** `58edd998de931e6effa0f17bd3d1662e9ffb4c11` (`explore-typescript-lsp-editor-diff`)
**Scope:** single commit, 35 files, +2456/−17. Working tree clean at candidate.
**Verdict:** ⛔ Not ready — 2 × P1 (one crash on a supported surface, one code-execution trigger).

## Intent

Host-side TypeScript language server support for hover, go-to-definition and find-usages in
source editors and working diffs. Editor buffers sync per client session; diff actions are
enabled only when the current file matches the captured snapshot. Adds four authenticated
WebSocket RPCs, a results picker, and desktop packaging for the language runtimes.

## Reviewers and lenses

Four read-only reviewer subagents in constrained mode (user cap: 4), disjoint lens groups:
correctness+reliability, security+api-contract, testing+performance,
project-standards+maintainability+frontend. All mandatory lenses covered; optional lenses
security, api-contract, reliability, performance and frontend were warranted and assigned.

## Validation actually performed

- Full diff read by all four reviewers; orchestrator independently re-verified every finding
  below against the code.
- Executed (by the testing reviewer, real results): `vitest run` on
  `packages/app/src/code-language/model.test.ts`, `git/diff-document/hit-testing.test.ts`,
  `workspace/file-open/index.test.ts` (3 files, 35 tests pass);
  `packages/protocol/src/code-language.test.ts` (1 pass);
  `packages/server/src/server/code-language/{diff-snapshot,session}.test.ts` (11 pass);
  plus `session.test.ts --reporter=verbose` for per-test timings.
- `npm run lint` on the changed app files: 0 warnings, 0 errors (9 files).
- NOT run: full suites, typecheck, Playwright, desktop suite, the daemon. No benchmarks.
  Per-file counts in #6 are mechanically derived, not measured.

---

## Findings

Every finding carries `S/F → P`. Sites are `file:line` at the candidate revision.

### P1

**CR1-1 — Narrow-window Changes view crashes outright.** S1/F1 → P1 · blocks · confidence 100
· blast radius all-users (web/desktop) · frontend
`packages/app/src/git/diff-document/surface.web.tsx:78`,
`packages/app/src/code-language/use-actions.web.ts:9`,
`packages/app/src/components/compact-explorer-sidebar.tsx:494`

- **Impact:** On web and Electron at a compact form factor, opening Explorer → Changes throws
  `PaneContext is required` and the surface stops rendering. Diff-introduced regression: before
  this commit `DiffSurface` had no pane dependency and mounted anywhere. Recovery requires
  widening the window. Native is unaffected — it resolves `surface.native.tsx`.
- **Invariant:** A hook added to a shared leaf component must be safe at every mount site of
  that component. Basis: inference from the single `PaneProvider` plus a throwing `invariant`.
- **Checked:** `usePaneContext` is `invariant(value, ...)` (`panels/pane-context.tsx:70-73`) —
  it throws, it does not return null. Exactly one `<PaneProvider>` exists
  (`screens/workspace/workspace-pane-content.tsx:157`). `ChangesSurface` has two mount sites:
  `panels/diff-panel.tsx:132` (inside the pane host, safe) and
  `components/compact-explorer-sidebar.tsx:494`, reached from `CompactExplorerSidebarHost` at
  `app/_layout.tsx:599` — the root layout, above the provider. `ChangesSurface`
  (`git/diff-pane.tsx:1541`) renders `DiffDocument` at :1890, and `git/diff-document/index.tsx:35`
  renders `DiffSurface` unconditionally. The `enabled` argument does not help: `usePaneContext()`
  is the hook's first statement and runs before `enabled` is consulted at `use-actions.web.ts:19`.
- **Proof:** PROPOSED (not executed) — narrow the web app below the compact breakpoint, open the
  Explorer sidebar, select Changes in a workspace with a modified file. Expect
  `Error: PaneContext is required`. Regression test: render `ChangesSurface` with no
  `PaneProvider` and assert it mounts.
- **Fix:** Read the context defensively in `useLanguageActions` (a `useContext` without the
  invariant, returning null when absent), or move the call behind the `enabled` gate.
- **Gate:** Blocks — a supported surface crashes, and the new e2e spec cannot catch it because
  `openChangesPanel` runs at a desktop viewport, which takes the pane presentation.

**CR1-2 — Opening a TypeScript file executes the repository's own tsserver.**
S1/F2 → P1 · blocks · confidence 100 · blast radius single-user · security
`packages/server/src/server/code-language/process.ts:42`,
`packages/server/src/server/code-language/process.ts:92`,
`packages/server/src/server/code-language/process.ts:49`

- **Impact:** Hovering or invoking go-to-definition on a `.ts` file runs a JS file the workspace
  controls, as the daemon user, with `{ ...process.env }` inherited — so daemon-held provider
  API keys are in the child's environment. The user observes nothing; the hover just works.
  The reviewer framed the trigger as "a repo that ships a committed `node_modules/typescript`",
  which understates reach: SECURITY.md:54 documents _checking out a change request from a
  different repository_ as a first-class workflow, and a contributor authoring that branch can
  simply add the two files to their PR. The attacker controls the precondition. This also grants
  code execution to a principal holding only `workspace.read`, which today confers read only.
- **Invariant:** SECURITY.md:54 — checking out a foreign change request does not run that
  workspace's code until you explicitly run setup. Basis: public documentation.
- **Checked:** `createRequire(join(cwd, "package.json")).resolve("typescript/lib/tsserver.js")`
  walks `<cwd>/node_modules` first and only falls back to the daemon bundle on failure; the path
  becomes `initializationOptions.tsserver.path`. I confirmed the execution independently in the
  vendored language server: `getUserSettingVersion` (cli.mjs:22176) returns the supplied path
  verbatim, and `NodeTsServerProcessFactory.fork` (cli.mjs:18227) calls `require.fork(tsServerPath, ...)`.
  Ruled out as _not_ additional vectors: tsconfig `plugins` (no `--allowLocalPluginLoads`) and
  automatic typing acquisition (disabled at process.ts:91). No trust prompt gates which
  workspaces get code intelligence. Every other `createRequire` in `packages/server/src` is
  rooted at `import.meta.url`, so there is no precedent making this consistent. The
  "attacker already has shell" exclusion does not apply — the premise is a repo checked out but
  never run, exactly the state SECURITY.md:54 describes.
- **Proof:** PROPOSED repro (not executed): in a scratch repo add
  `node_modules/typescript/package.json` and `node_modules/typescript/lib/tsserver.js` containing
  `require("node:fs").writeFileSync("/tmp/pwned", JSON.stringify(process.env))`, plus a
  `tsconfig.json` and an `a.ts`; register it as a workspace, open `a.ts`, hover a symbol.
  Regression test: assert the spawned server's tsserver path is the bundled one even when the
  fixture ships a sentinel.
- **Fix:** Delete the `createRequire(cwd)` block and pin `tsserver.path` to the bundled runtime
  unconditionally — the desktop packaging change in this PR already ships it. If per-workspace
  TypeScript versions are wanted later, they need an explicit trust decision, not a silent default.
- **Gate:** Blocks — it defeats a guarantee SECURITY.md states in prose, and the fix is a deletion.

### P2

**CR1-3 — A failed hover opens a modal that blocks the whole app.**
S2/F1 → P2 · blocks · confidence 100 · single-user · correctness/frontend
`packages/app/src/code-language/actions.ts:111`, `actions.ts:114`,
`packages/app/src/code-language/overlay.web.tsx:139`

- **Impact:** Any hover query that fails — daemon disconnect, language server missing or crashed,
  30 s server cancellation, 35 s RPC timeout — publishes a `popup` instead of a tooltip, which
  renders a full-viewport `aria-modal` dialog with a dimming backdrop and a focus trap, triggered
  by nothing but the mouse resting on a symbol. It is sticky: `hover()` early-returns while the
  state is `popup` and `dismissHover()` only acts when the state is _not_ `popup`, so only Escape
  or a backdrop click clears it — and hovering again reproduces it. Disconnection is routine for
  Paseo's core remote use case, which is what puts this at F1.
- **Invariant:** A hover is a passive transient affordance and must never take over the viewport.
  Basis: the code's own two presentations (`hover` = positioned tooltip, `popup` = `aria-modal`
  dialog), plus docs/design.md §11 ("state surfaces at the smallest scope it affects").
- **Checked:** I traced every preceding branch. `popup = operation !== "hover"` is false for
  hover, so nothing publishes up front — but both failure paths ignore that: the `catch`
  publishes a popup unconditionally, and `else if (popup || result.kind === "error")` fires on a
  server error result for a hover too. Editor hovers carry no `targetContentId`, so a `stale`
  result also falls into the popup branch. The `TITLE` map at overlay.web.tsx:376 has a `hover`
  entry, so the modal is reachable with `operation: "hover"` by that table's own design. I checked
  whether this fires on every diff: it does not — `language-target.ts:16` gates on
  `isTypeScriptFile`, so non-TypeScript cells return null and take the dismiss path.
- **Proof:** PROPOSED unit test: construct `LanguageActions` over a `WorkspaceLanguage` whose
  transport has `isConnected = false`, call `run(target, "hover")`, assert
  `getSnapshot().kind !== "popup"` — it is currently `{kind:"popup", status:"error"}`.
  Manual repro: open a `.ts` file, stop the daemon, rest the mouse on an identifier for 300 ms.
- **Fix:** Cause-level — the `if/else if` chain couples `operation` and `result.kind` implicitly.
  Split `LanguagePresentation` by operation (one state machine for the hover card, one for the
  picker) so a hover producing a modal is unrepresentable. A minimal fix is an
  `operation === "hover"` guard on both failure branches.
- **Gate:** Blocks — a transient backend failure, in the condition this product is built for,
  makes the UI unusable over any TypeScript surface and recurs on every hover.

**CR1-4 — The hover card can't actually be used.**
S2/F1 → P2 · conditional · confidence 85 · single-user · frontend
`packages/app/src/code-language/actions.ts:60`, `packages/app/src/code-language/editor.web.ts:51`,
`packages/app/src/code-language/overlay.web.tsx:117`

- **Impact:** Two symptoms of one cause — the card is presented as read-only decoration but
  contains interactive content. (a) `hover()` calls `dismiss()` unconditionally before scheduling,
  with no "same target, keep it up" check and no grace corridor, so every `mousemove` blinks the
  card away and restarts the 300 ms debounce. The card renders at `anchor.y + 18`, inside the
  editor's own bounding box, so travelling to it fires moves that dismiss it — which makes the
  `<button>` in the stale variant unreachable by mouse. (b) It is a `role="tooltip"` portal with
  no `aria-live` and no association to the editor, so the deliberate `Mod-k Mod-i` keyboard entry
  point produces a surface a screen reader never announces, and that same button is unreachable
  by keyboard. Separately the results list breaks listbox ownership (a plain spacer `<div>` sits
  between `role="listbox"` and its `role="option"` children) and omits `aria-setsize`/`aria-posinset`,
  so a 300-result list announces as 12.
- **Invariant:** An interactive floating panel must be reachable from its trigger — docs/hover.md
  failure mode 3, same class, different mechanism (a move handler rather than a bounding box).
  Plus docs/floating-panels.md: "Do not add component-local global Escape listeners"; the hover
  branch uses a raw `window.addEventListener` at overlay.web.tsx:65 while the popup branch
  correctly uses `useWebOverlayRegistration`.
- **Checked:** The `mouseleave` escape at editor.web.ts:65 guards leaving the editor _into_ the
  card, but the preceding `mousemove` has already dismissed it. The popup-open early return does
  not apply while the pointer is inside the editor. The e2e spec does a single `symbol.hover()`
  then `page.mouse.move(10, 10)` — it never moves _within_ the editor, so it passes.
- **Proof:** PROPOSED Playwright step in the existing spec: after `expect(hover).toContainText("42")`,
  do `symbol.hover({ position: { x: 2, y: 2 } })` and assert the card is still visible.
- **Fix:** Keep the card up when the target is unchanged; add a grace corridor or route the card
  through the shared overlay registration so it owns focus and Escape like the popup does.
- **Gate:** Conditional — blocking if the stale card's action button is meant to be usable.

**CR1-5 — Pointer movement and list scrolling redo work on every event.**
S2/F0 → P2 · conditional · confidence 100 · all-users · performance
`packages/app/src/git/diff-document/surface.web.tsx:654`, `surface.web.tsx:665`,
`packages/app/src/code-language/overlay.web.tsx:226`

- **Impact:** `pointerMove` now begins with `hoverCode(event)`, which calls `pointHit(event)`;
  the original `const hit = pointHit(event)` at :665 still runs. Each call does a
  `getBoundingClientRect()` forced layout, a linear `files.find`, a binary row search and an
  O(line-length) glyph walk — all paid twice per event. Then `hoverCode` funnels into
  `dismiss()` → `publish({kind:"closed"})`, which allocates a fresh object with no already-closed
  short-circuit; `LanguageOverlay` reads it via `useSyncExternalStore`, so `Object.is` fails and
  React commits on every pointer move. This applies to the whole Changes panel, including diffs
  with no TypeScript in them, on a surface that is canvas-painted precisely to avoid per-move
  React work. Separately, scrolling the usages list refetches and blanks every snippet each
  64 px step. Future-change cost: anyone tuning diff scroll performance now has to discover that
  the language feature, not the diff, is generating the commits.
- **Invariant:** docs/coding-standards.md §React — "Match state updates to the actual visual
  cadence"; docs/qa.md requires before/after numbers for hot-path changes, and none were supplied.
- **Checked:** `hoverCode` is called unconditionally at the top of `pointerMove`, not inside the
  drag branch; `language` is non-null for any working diff because surface.web.tsx:78 gates on
  `mode.kind === "working"`, not on file type; `publish` has no equality guard. `LanguageOverlay`
  returning `null` early is not free — it still runs `getTheme()`, two overlay hooks and four
  memos. For the snippet half I confirmed the mechanism directly: `overlay.web.tsx:226` passes
  `dataShape: "value"` with `staleTimeMs: 0` and the window slice in the query key, and
  `data/query.ts:105` applies `keepPreviousData` only when `dataShape === "list"` — so
  `snippets.data` is `undefined` during each fetch and every row falls back to "…".
- **Proof:** Mechanically established from the cited sites. Not measured. Measurement: React
  Profiler trace while sweeping the pointer across a large diff — expect one commit per
  `pointermove` and 2× `hitTestDiffDocument` self-time versus base.
- **Fix:** Hoist the single `pointHit(event)` result and pass it to `hoverCode`; early-return in
  `publish` when the next state is already `closed`; switch the snippets query to
  `dataShape: "list"` with a non-zero `staleTimeMs`.
- **Gate:** Conditional — all three fixes are local and small.

**CR1-6 — Every query and every diff refresh re-reads and re-hashes the same files.**
S2/F0 → P2 · conditional · confidence 95 · all-users · performance
`packages/server/src/server/code-language/session.ts:176`,
`packages/server/src/utils/checkout-git.ts:3389`, `checkout-git.ts:3460`

- **Impact:** Two symptoms of one cause — the feature re-derives state it already has.
  (a) `executeQuery` always calls `process.sync(path, content, ++workspace.sequence)`. Because
  the version is a fresh counter every time, `TypeScriptProcess.sync`'s `opened.get(path) !== version`
  is always true, so a full-text `didChange` is pushed to tsserver before _every_ query — including
  queries where nothing changed — invalidating its parse and forcing a re-parse on the critical
  path of every 300 ms hover. (b) Structured diff generation gained a pre-pass and a post-pass that
  each `stat` → `readFile` → `stat` → SHA-256 every changed TypeScript file, so 4 stats, 2 reads
  and 2 hashes per file, serially; `identifyLanguageDiffs` then spawns `git show <sha>:<path>`
  per file for a blob `buildHighlightedTrackedDiffFile` already fetched and discarded. A 200-file
  TypeScript branch is ~200 extra git subprocesses per refresh, and `scheduleTargetRefresh`
  debounces at only 150 ms, so this is steady state while an agent writes files.
- **Invariant:** Work derived once is reused. Basis: the project's documented coalescing
  discipline for its other interactive pipelines (docs/terminal-performance.md,
  docs/agent-stream-performance.md) and docs/qa.md's hot-path requirement for git polling.
- **Checked:** The client side is _not_ the culprit — `model.ts` debounces at 150 ms and
  `flush()` skips documents where `sent === version`, so the redundancy is introduced solely by
  the server's unconditional re-sync. The diff work is correctly gated behind
  `compare.includeStructured` and skips non-TypeScript and >1 MiB files, and the new `rev-parse`
  only runs when `targetRef` is set — that narrows blast radius but bounds neither the file count
  nor the duplicate `git show`. `runGitCommand` goes through `GitProcessScheduler`, so the extra
  spawns contend with the daemon's other git work rather than running free.
- **Proof:** Mechanically established. Not measured. Measurement: time `getCheckoutDiff` with
  `includeStructured: true` on a 200-file TypeScript branch at base vs candidate; and log
  `didChange` notifications while hovering the same identifier five times — expect 5 full-text
  notifications where 1 or 0 is required.
- **Fix:** Compare content identity per path before sending `didChange`; thread the highlighter's
  already-fetched target blob into `identifyLanguageDiffs` and collapse the two read passes.
- **Gate:** Conditional — worth a measurement on a large repo before merge.

**CR1-7 — Language servers accumulate without a cap and retry failures at hover cadence.**
S2/F2 → P2 · conditional · confidence 90 · single-user (host memory/CPU) · reliability
`packages/server/src/server/code-language/session.ts:233`,
`packages/server/src/server/session.ts:845`,
`packages/server/src/server/code-language/session.ts:211`

- **Impact:** `CodeLanguageSession` is constructed per WebSocket session, and its `workspaces`
  map grows one entry — and one tsserver — per distinct `cwd`, with no cap and no cross-session
  sharing. Desktop + phone + a browser tab on one large monorepo is three full TypeScript
  programs resident. The documented five-minute idle reap cannot fire while any editor buffer is
  retained (`idle()` returns early when `documents.size` is non-zero), so one open `.ts` tab pins
  a tsserver for the life of the connection. Separately, `initializeWorkspace` nulls the process
  and rethrows with no failure memo and no backoff, so a workspace with a broken or
  ABI-incompatible `typescript` re-spawns a doomed Node process on every 300 ms hover dwell —
  each one also raising the modal from CR1-3.
- **Invariant:** The daemon's footprint is bounded by workspaces, not by clients × workspaces ×
  tabs, and a repeatedly failing subprocess backs off. Basis: inference; the architecture section
  this PR adds states the five-minute stop policy as if it always applies, which it does not once
  a buffer is retained, and records no ceiling.
- **Checked:** Teardown on disconnect _is_ wired (`cleanupConnection` → `Session.cleanup()` →
  `codeLanguage.dispose()` → `closeWorkspace` → `process.stop()` with a 2 s tree-kill deadline),
  so this is steady-state concurrency, not leakage past disconnect. Spawning is lazy, so idle
  clients cost nothing. The per-client model is deliberate and tested — `session.test.ts`
  "isolates unsaved buffers" constructs two sessions on one `cwd`, which is two live tsservers in
  one test — but deliberate isolation argues for per-session _documents_, not per-session
  _processes_. No cap, no LRU, no `--max-old-space-size` on the spawn.
- **Proof:** PROPOSED — sync and query in N distinct temp directories on one session and assert
  live children stay under a cap; it currently equals N. Manual: open the desktop app and a
  browser tab on the same workspace, hover in each, `ps` shows two tsservers for one project.
- **Fix:** A per-daemon process ceiling with LRU eviction, or cross-session process sharing keyed
  by cwd with per-session document overlays; plus a per-workspace failure cooldown before the
  next `start()`.
- **Gate:** Conditional.

**CR1-8 — Go to definition can land on a file the app then refuses to open.**
S2/F2 → P2 · conditional · confidence 90 · single-user · correctness
`packages/server/src/server/code-language/process.ts:186`,
`packages/app/src/code-language/use-actions.web.ts:22`,
`packages/server/src/server/file-explorer/service.ts:808`

- **Impact:** tsserver returns canonical, symlink-resolved absolute paths. The app forwards them
  verbatim to `openFileInWorkspace`, and `resolveScopedPath` asserts containment first against the
  _raw_ configured root before canonicalising. So when the workspace root contains a symlinked
  segment, or the definition lives in an `npm link`ed sibling, the picker shows the result and its
  snippet but selecting it yields an access error instead of an editor.
- **Invariant:** A location the feature offers must be openable. Basis: the PR's stated intent
  ("precise symbol navigation") and its own e2e spec, which asserts F12 opens `library.ts`.
- **Checked:** The PR's own server test acknowledges the canonicalisation —
  `session.test.ts:137` asserts `toBe(await realpath(declaration))` rather than the literal path.
  `buildAbsoluteExplorerPath`/`resolveWorkspaceFilePaths` do not canonicalise either. The common
  npm/pnpm `node_modules` case realpaths back _inside_ the repo, which is why the e2e passes —
  it breaks only when a segment of `cwd` itself is a symlink or for linked local packages. That
  narrows frequency but does not remove the bug.
- **Proof:** PROPOSED repro: `ln -s /real/repo ~/linked-repo`, register `~/linked-repo` as a
  workspace, open a `.ts` file, F12 a cross-file symbol.
- **Fix:** Canonicalise the workspace root in the first containment assertion, or map canonical
  target paths back through the root before handing them to `openFileInWorkspace`.
- **Gate:** Conditional.

**CR1-9 — The results dialog reimplements primitives the design system owns.**
S2/F0 → P2 · conditional · confidence 100 · all-users · project-standards
`packages/app/src/code-language/overlay.web.tsx:337`, `overlay.web.tsx:196`, `overlay.web.tsx:312`

- **Impact:** The find-usages surface is a raw `<div>` modal with its own virtualised searchable
  list, duplicating `<AdaptiveModalSheet>` and `<Combobox>`. Concrete entries on docs/design.md
  §14's forbidden list: hardcoded hex (`#0004`, `#0005`, and `"#8883"` for the _selected row_,
  which §12 says is `surfaceSidebarHover`/`surface2`); off-scale spacing (`padding: 16`,
  `borderRadius: 8/4`, `marginBottom: 12`, `height: 64`, `fontSize: 12` as raw numbers while
  `theme` is already in scope at line 30); and "raw Modal for a focused task" when §6 names
  `<AdaptiveModalSheet>` for anything earning a backdrop and `<Combobox>` for a searchable list.
  Future-change cost: a theme or density change updates the design system and silently misses
  this surface — and because the theme is read via `UnistylesRuntime.getTheme()` into memo deps,
  a live theme switch leaves the open popup painted in the old theme.
- **Invariant:** docs/design.md §2 — "Consistency comes from component reuse... When two surfaces
  do the same semantic thing in two different ways, one of them is wrong." Basis: documentation.
- **Checked:** The PR _does_ reuse the shared overlay infrastructure (`getOverlayRoot`,
  `useGlobalWebOverlayLayer`, `useWebOverlayRegistration`), so the layering and focus-scope half
  of docs/floating-panels.md is honoured — this finding is scoped to the visual primitives.
  docs/unistyles.md reserves raw DOM for "terminal hosts, virtualized web rows, or third-party
  drag wrappers"; a results picker is not on that list. `useUnistyles()` is correctly not used.
- **Proof:** `npm run lint` reports 0 warnings on these files — this is doc-enforced only. The
  hex literals and numeric styles are at the cited lines.
- **Fix:** Move the picker onto `<Combobox>` inside an `<AdaptiveModalSheet>`. That also removes
  ~200 lines of hand-rolled virtualisation and keyboard handling, fixes the compact layout, and
  restores theme reactivity.
- **Gate:** Conditional — the surface works; it is off-system in a repo whose design doc is
  unusually prescriptive.

**CR1-10 — Changing the snapshot rule means editing four sites that must agree.**
S2/F2 → P2 · non_blocking · confidence 90 · developer-only · maintainability
`packages/server/src/server/code-language/diff-snapshot.ts:47`,
`packages/app/src/git/diff-document/language-target.ts:18`,
`packages/server/src/server/code-language/session.ts:164`

- **Impact:** Demonstrated future task — _allow language actions on the base side of a diff_
  (the architecture section this PR adds explicitly closes that door, so relaxing it is the
  natural next request). It requires coordinated edits to four independent decisions: the
  server's capture (`identifyLanguageDiffs`), the app's cell eligibility (`diffLanguageTarget`,
  which re-derives from `sourceIdentity.side`, `cell.type`, `lineNumber` and `targetContentId`),
  the server's `queryContent` re-check against buffer and disk, and `executeQuery`'s _third_
  read-and-hash after the LSP round-trip. The BOM convention is written twice in incompatible
  shapes — `content.ts:5` strips `^﻿` from the whole file, `language-target.ts:27` tests
  `lineNumber === 1 && content.startsWith("﻿")` on a cell. If either drifts, every column on
  line 1 of a BOM file is silently off by one. A single server-owned "is this target valid, and
  what content should I analyse" boundary would hide all four and delete the app's copy.
- **Invariant:** docs/coding-standards.md §Structure — "Centralize policy. The same discriminator
  branched in 3+ files → policy table."
- **Checked:** There is no shared helper — `language-target.ts` imports only `isTypeScriptFile`
  and `buildAbsoluteExplorerPath`. The client-side copy is not merely advisory: it enables and
  disables menu items (`surface.web.tsx:969`), so drift shows enabled actions that always return
  `stale`. No test asserts agreement between `content.ts` and `language-target.ts`.
- **Proof:** The four sites are cited; the three reads of the same path per query are at
  `session.ts:157`, `:168` and `:172`.
- **Fix:** Have the app send `{path, position, targetContentId?}` and let the server answer
  `valid | stale`.
- **Gate:** Non-blocking.

### P3

**CR1-11 — Branch diff now errors on an unborn HEAD.** S2/F3 → P3 · non*blocking ·
confidence 100 · correctness · `packages/server/src/utils/checkout-git.ts:3352`
The new unconditional `git rev-parse <targetRef>` sits \_outside* the `try` at :3356 that exists
to recover from exactly this failure, so an orphan branch with an explicit base ref now rejects
where it previously diffed against the empty tree. **Checked:** verified by reading :3340-3365 —
the `rev-parse` precedes `listCheckoutFileChanges` and its `isUnbornHeadDiffError` fallback;
`uncommitted` mode is unaffected because `resolveCheckoutDiffRefs` returns no `targetRef` there.
**Fix:** move the `rev-parse` inside the existing `try`.

**CR1-12 — Split panes on one file overwrite each other's language buffer.** S2/F3 → P3 ·
non*blocking · confidence 85 · maintainability · `packages/app/src/code-language/model.ts:44`
`retain(path, content)` increments the lease on an existing document and then applies the \_new*
caller's content. `FileEditorModel` is per-component (`pane.tsx:500`), so "open to side" on an
already-open file pushes the second pane's text into the shared document; hover in the first pane
then reports types for the other pane's buffer, and both version checks pass so no staleness is
reported. **Fix:** key documents by pane, or reject conflicting content on retain.

**CR1-13 — The results popup can outlive the tab it was opened from.** S2/F3 → P3 ·
non_blocking · confidence 80 · frontend · `packages/app/src/code-language/overlay.web.tsx:137`
Panels stay mounted when hidden (`RetainedPanel` applies a hidden style), and the overlay portals
to `document.body`, so the parent's hidden style does not reach it. A keyboard tab switch while
the popup is open leaves a backdrop and focus trap over an unrelated tab. **Checked:** the
backdrop's `onMouseDown` close makes the mouse path unreachable, so this is keyboard-only;
neither `usePaneFocus()` nor `useRetainedPanelActive()` appears in the new code.
**Fix:** gate `visible` on the retained-panel active signal, per docs/floating-panels.md gotcha 2.

**CR1-14 — Workspace cleanup can close the wrong language workspace.** S3/F3 → P3 ·
non_blocking · confidence 90 · correctness · `packages/server/src/server/code-language/session.ts:238`
`retainWorkspaces` builds its keep-set from raw registry `cwd` strings but matches them against
map keys produced by `resolve()`. Any normalisation difference (trailing slash, relative form)
tears down a live workspace mid-use — bounded, since it respawns, but in-flight queries return
`stale`. **Fix:** normalise `roots` with the same `resolve` before comparing.

**CR1-15 — Standards items.** S3/F0-F2 → P3 · non_blocking · confidence 95-100 ·
developer-only · project-standards / api-contract

- **Missing COMPAT tags.** `features.codeLanguage` is added at `packages/protocol/src/messages.ts:3659`
  and set at `packages/server/src/server/websocket-server.ts:1730` with no `// COMPAT(...)` tag at
  either site, so `rg "COMPAT\("` — which docs/protocol-compatibility.md calls the full cleanup
  backlog — will not find the two sites that also have to be deleted. Every one of the ~30
  neighbouring feature flags is tagged; the app-side read _is_ tagged correctly. Two comment lines.
- **Noun-named RPC.** `code.language.snippets.request` uses a noun where
  docs/rpc-namespacing.md:14 requires a verb and gives this exact case as its example
  ("If you would name an RPC `noun.request`, name it `get_noun.request` instead"). The client
  method is already `getCodeSnippets`. Three existing RPCs are noun-ish, so the rule is not
  perfectly enforced — but the rename is free now and needs a tagged shim after release.
- **Ellipsis character.** `"Finding locations…"` uses U+2026; docs/design.md §10 requires a
  literal three-dot ellipsis, and `en.ts` uses `...` 114 times versus `…` 23.
- **`.web`-suffixed import specifiers.** Both consumers import `@/code-language/use-actions.web`
  rather than letting Metro resolve. It works today only because both importers are themselves
  `.web` files. See latent hazards.
- **Native context menu is inconsistent.** `preserveNativeMenu` stops propagation only when
  `actions` is null, so right-clicking a `.ts` file gives Paseo's menu while a `.js` file in the
  same editor gives the browser's.
- **Architecture doc restates logic.** `docs/architecture.md:231-233` restates the `5 * 60_000`
  constant and :236-240 restates the four snapshot sites line for line, against CLAUDE.md's
  "Don't document logic... Code-level facts belong in comments next to the code." The
  per-connection rationale and the `useSyntaxServer: "never"` gotcha are good and should stay.

---

## Latent hazards — guarded today, no priority

**L1 — Code-intelligence file reads bypass the daemon's path containment.**
`packages/server/src/server/code-language/session.ts:222` (`snippets`, which resolves
client-supplied `location.path` against a client-supplied `cwd` and `readFile`s it with _no_
extension check and no containment check), `session.ts:97`, `session.ts:119`.
**Guarded by:** SECURITY.md:52 — "Connected clients are trusted operators of the daemon user.
File previews... may read any regular file the daemon process can read." The sibling
`WorkspaceFilesSession.handleFileSubscribeRequest` already passes `request.cwd` through as the
containment root with no check that it is a registered workspace, so an authenticated
`workspace.read` client can already read any daemon-readable file. The new handlers add no
authority. **S-if-unguarded:** S1. docs/permissions.md explicitly plans workspace-scoped grants
and notes file preview "must gain resource enforcement before workspace-specific access ships".
Whoever implements that will retrofit `assertWithinWorkspace` in `file-explorer/service.ts:803-824`
and will not find these four handlers, because they never call the file service.
**Unguarded by:** shipping the `Grant.resource = {kind:"workspace"}` model, or any change making
`cwd` mean "a registered workspace". **Local enforcement:** route path resolution through the
existing `resolveScopedPath` (which also closes the symlink escape these handlers currently have —
SECURITY.md:52 promises "path normalization and symlink checks in the daemon file service", and
these are the first file reads outside it); at minimum add an `isTypeScriptFile` check to
`snippets` to match `query`. Note the legitimate tension: go-to-definition results genuinely land
outside `cwd`, so the right rule is "snippets may only be requested for paths this session
returned", not a plain root check.

**L2 — `.web`-suffixed imports would bundle web-only code into native.**
`packages/app/src/file-pane/editor/view.web.tsx:7`, `git/diff-document/surface.web.tsx:1`.
**Guarded by:** both importers are themselves `.web` files, so only the web bundle reaches them;
the native siblings (`view.tsx`, `surface.native.tsx`) are clean. **S-if-unguarded:** S1 — because
the specifier names the file literally, Metro would _resolve_ `use-actions.web.ts` on native rather
than fail, so `createPortal`/`document` in `overlay.web.tsx` crash at runtime instead of failing
the build. **Unguarded by:** any unsuffixed component importing those specifiers.
**Local enforcement:** drop the `.web` and let Metro resolve — then an unsuffixed importer fails
loudly at bundle time.

**L3 — `query()` can reject out of the message dispatcher after teardown.**
`packages/server/src/server/code-language/session.ts:115` — `this.workspace(query.cwd)` is outside
the `try` and throws "Language session closed" when disposed; `Session.handleMessage` does not wrap
the returned promise. **Guarded by:** `websocket-server.ts:2024` disposes inside
`cleanupConnection`, after the socket is removed from `this.sessions`. **S-if-unguarded:** S2 — an
unhandled rejection in the daemon message loop plus a silently dropped response the client waits
35 s on. **Unguarded by:** a reconnect path that keeps dispatching on a cleaned-up session, or any
in-process caller outside the socket lifecycle — the tests already call `handle` directly.
**Local enforcement:** move the `workspace()` call inside the existing `try`.

**L4 — Cancelling a query does not settle it if the language server ignores `$/cancelRequest`.**
`packages/server/src/server/code-language/session.ts:118`. `vscode-jsonrpc` only _sends_
`$/cancelRequest`; the promise settles when the server responds. A wedged tsserver leaves the
await pending forever, leaking the `readers` entry that prevents idle reaping.
**Guarded by:** `process.ts:194` — `stop()`'s 2 s tree-kill, reached via `dispose()`/`closeWorkspace`,
forces exit and rejects pending responses, so the leak cannot outlive the client session.
**S-if-unguarded:** S2. **Unguarded by:** making language workspaces outlive the client session —
which is the natural fix for CR1-7. **Local enforcement:** race `process.query` against the token
so it rejects locally, and assert `readers` is empty after a cancelled query.

---

## Testing gaps

The new server tests are genuinely good: `session.test.ts` drives a real
`typescript-language-server` + tsserver (215-477 ms per test, consistent with real project loads)
and covers path aliases, project references, inferred `.mts` projects, `node_modules` declaration
files, buffer isolation between sessions, and tsserver observing on-disk changes to unopened
dependencies. `diff-snapshot.test.ts` uses real temp dirs with an injected port. The protocol test
exercises the real generated outbound validator. The e2e spec is a real end-to-end run, not a stub.
The gaps are at the edges:

- **Every failure state ships unverified.** `LanguageActions` has no test file. The four strings
  a user sees on failure — error, retry, stale, open-current — and the code paths that produce
  them are exercised by nothing. `actions.retry` and `actions.openCurrent` are never invoked by
  any test. This is what let CR1-3 through. Against docs/testing.md: "Every fallible action needs
  behavioral coverage for success and failure."
- **The one cancellation test is vacuous.** `session.test.ts:175` cancels before `start()` is ever
  called, so it passes with no language server in existence. Executed evidence: that test takes
  **2 ms** while its neighbours take 215-477 ms. Nothing verifies the token reaches
  `connection.sendRequest(HoverRequest.type, params, token)`. The client aborts on every pointer
  move, so mid-flight cancellation is the common case, not the edge case.
- **The four RPCs are never tested across the wire.** `CodeLanguageSession` is tested by direct
  method calls, bypassing `Session` dispatch, the permission check, and `emitForSource`.
  `dispatchWorkspaceFileMessage` falls through to `default: return undefined` — a silent drop, so
  a routing regression hangs the client for its full 35 s timeout. Deleting the four `case` labels
  at `session.ts:2694` leaves every server unit test green. docs/ad-hoc-daemon-testing.md exists
  for exactly this.
- **Crash recovery has no test.** Nothing verifies that an in-flight query survives the child
  exiting, that the re-created process re-syncs retained buffers, or that the rotated generation
  makes the client discard results from the dead process. `process.ts` takes a hardcoded `spawn`
  with no seam, which is itself the testability signal.
- **Windows temp-dir cleanup will fail.** `session.test.ts:12-15` calls the non-awaitable
  `dispose()` then immediately `rm`s the directory the live child holds as its cwd. `force: true`
  suppresses ENOENT, not EBUSY/EPERM. The repo already has the remedy as an established
  convention — `{maxRetries, retryDelay}` at `test-utils/paseo-daemon.ts:121` and six other sites
  — and neither new test file uses it. `server-tests (windows-latest)` is a required CI leg.
  (Executed on macOS: 7 passed in 1.95 s; macOS tolerates unlinking a busy cwd, so the local green
  does not cover Windows.)
- **The windowed results list is only ever driven with one or two results,** so the virtualisation
  arithmetic and arrow-key scroll-into-view are unexercised. The arrow-key handler hardcodes 384
  as the viewport height even when the list is shorter — undetectable at n=1.
- **The diff e2e aims its clicks by re-deriving three production layout constants** in a detached
  canvas (`code-language.spec.ts:86-97` hand-inlines `12 + 8` as `+ 20` and hardcodes `digits` to
  2). Usable tolerance is roughly ±3.5 px over a ~105 px offset. A change to
  `lineNumberGutterWidth` would keep every unit test green and silently retarget the click. The
  real defect is that the canvas surface exposes no test seam.
- **A banned weak assertion.** `expect(server.dependencies["typescript-language-server"]).toBeDefined()`
  is the assertion docs/testing.md:42 forbids by name. It proves a string is in a YAML file, not
  that `asarUnpack` materialises `tsserver.js` next to `app.asar`.
- **The second e2e test can exceed the 60 s default timeout** — 30 s for the changes panel plus
  30 s for a cold tsserver spawn, with no `test.setTimeout`. The first test in the same file
  raises to 120 s for that exact reason.

## Optional maintenance proposals (not defects)

1. Collapse the four snapshot-validity decisions (CR1-10) into one server call.
2. Give `WorkspaceLanguage` a per-path revision map instead of one workspace counter, so an edit
   to any buffer stops cancelling unrelated in-flight hovers and `stale` stops meaning three things.
3. Move the picker onto `<Combobox>` inside `<AdaptiveModalSheet>` (CR1-9).
4. Split `LanguagePresentation` by operation rather than result kind, making CR1-3 unrepresentable.
5. Route the language-server spawn through the existing `createNodeEntrypointInvocation`
   (`packages/desktop/src/daemon/node-entrypoint-launcher.ts:36`) and share the asar-unpack rewrite
   — `unpackLanguageRuntimePath` is character-for-character the fourth copy of that regex in the repo.

## Residual risks

- **Unbounded reference sets** cross the wire with no `.max()` on `CodeLocationSchema` arrays
  (contrast `CodeSnippetsRequestSchema`, which caps at 100), and the client then `JSON.stringify`s
  each location and sorts with `localeCompare`. Mechanism is real; n is repository-dependent and
  no measurement was taken, so this is recorded as a risk rather than a finding (confidence 50).
- **Packaged-desktop spawn is unverified.** Whether the packaged app actually starts the language
  server needs a real packaged build; the new packaging test only string-matches config.
- **No performance numbers anywhere.** CR1-5, CR1-6 and CR1-7 are all mechanically established but
  unmeasured. docs/qa.md requires before/after numbers for hot-path changes.
- **Windows path handling is unexercised.** `session.test.ts` asserts `toBe(join(cwd, "lib.ts"))`
  in one place and `toBe(await realpath(...))` in another, which suggests those assertions are
  environment-sensitive; drive-letter casing through `fileURLToPath` was not checked.

## Unreviewed areas

`package-lock.json`. The app half was read in full by two of four reviewers and skimmed by the
security reviewer, who judged it to carry no wire-contract surface.
