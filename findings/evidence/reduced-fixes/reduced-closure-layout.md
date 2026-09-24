# Independent closure verification: layout persistence and navigation history

Read-only verifier: runtime fixer, not author of these app changes. No product/test edits, no test reruns, no broad review. Scope is FP1/CR1-1 and FP13/CR1-11 only.

Candidate: working tree on HEAD `23cb8e83c1a899b631d8b08a896992a5da0f7faa`.

## FP1 / CR1-1 — PASS, bounded closure supported

Guarantee: opening Background activity or its helper thread must retain all workspaces' saved layouts across persistence/recreation.

Inspected the public createWorkspaceLayoutStore/openTab/splitPaneEmpty/hideExplorerSidebar path, partialize, createValidatedPersistStorage set/get envelopes, merge/rehydrate, target normalization and ephemeral stripping, launcher target, and thread model/identity. Added discriminated-union entries match both target shapes exactly, including optional thread requestId. The existing validation adapter now accepts targets that normalizers retain. No storage version or migration is needed for an additive accepted variant. Existing default AsyncStorage production construction is unchanged.

Affirmative evidence: `/tmp/fp1-red-final.log` shows the public lifecycle test failing with a null persisted envelope before schema entries. `/tmp/fp1-green-final.log` shows 3/3 passing for activity and thread with/without requestId. The final test opens two distinct workspaces, splits the first, inserts a terminal and the requested background target, hides Explorer, verifies actual serialized layout envelope, then recreates/rehydrates through the same backing storage and compares full layouts and Explorer pane mapping. This exercises the authoritative persistence adapter rather than parsing an exported schema alone.

Maintenance fits accepted narrow scope: six schema lines plus optional standard StateStorage argument to existing factory; no new persistence owner, state, migration, dependency, or production caller obligation. No blockers found.

Gap: backing storage is deterministic in-memory StateStorage, not actual native AsyncStorage/Electron disk. Real serialization, validation, persistence middleware and hydration execute. This is adequate for the demonstrated schema omission, not a claim about platform disk failures. Already-erased layouts cannot be recovered by this fix.

## FP13 / CR1-11 — PASS, bounded closure supported

Guarantee: a transient first-visit workspace without a replayable tab cannot create a history entry that later destroys Forward; ordinary route/tab/empty-workspace behavior remains intact.

Inspected recorder React sampling and hydration guard, selected-tab/focus-restoration logic, history store/pushEntry/entriesEqual, goHistory focus/reopen/workspace-only branches, real layout factory/empty-pane restoration/closing, and target retarget equality. New guard excludes only workspace entries without tab or target. Settled empty main panes use New tab in layout creation/restoration, so the guard does not discard settled empty-workspace visits. Composer focus resolves to remembered pane; Explorer selection remains outside workspace focus. Same-ID target replacement still refreshes current replay payload without appending. In-memory session history means no stored legacy null-tab entries need migration.

Affirmative evidence: `/tmp/fp13-red.log` reproduces settings → tabless first workspace → settled agent tab → sessions; second Back stays at workspace instead of settings. `/tmp/fp13-green.log` shows final 3/3 passing, with Back twice/Forward twice retaining the full entries and index; settled New tab plus composer focus; same-ID retarget and reopening a closed file without Forward loss. The new tests drive real layout/history/replay with a typed route adapter and production recording function. `/tmp/fp13-recorder.log` shows existing 8/8 passing, covering actual React effect sampling, background-workspace changes, routes, current-entry replay no-op, retargets, composer focus and cold params. Existing route test was updated to create its intended settled workspace rather than asserting the buggy null-tab entry.

Maintenance fits accepted narrow scope: existing recording block moved into same-module callable function and one guard added. No new history state, route suppression flag, replay lifecycle, fallback, router behavior or dependencies. No blockers found.

Gap: real Electron keyboard/router/render timing was not exercised. Sampling effect is unchanged and existing React recorder tests plus real state/replay tests give affirmative evidence for the demonstrated state bug. No native route-tree code changed. This verdict does not claim end-to-end keyboard coverage or all future routing timing.

## Evidence identity

SHA-256 of reviewed files:

- workspace-layout-store.ts: e251e9af26ea0b368eca612122d79b8820c1126aacaa0b9dbcb77a3aec6afead
- workspace-layout-persistence.test.ts: d6036f87af5d83155ac762cf30f43a887a0c857d40c86b9543a1aef0dd9a12ef
- navigation/history/recorder.tsx: ef222d1b8ae1b07c970bdc3c344c2d1f99756857bd1b17970989cfe2f6092ba5
- navigation/history/record-location.test.ts: b4451576bb9064e73212fc05be8234f103f7715d0ca054360066777de6547791
- navigation/history/recorder.test.tsx: 142eb9078c9cbdbbc0deb28ec9c06109a05c450328e2f2213c04a71988d85857

Read implementation handoff `/tmp/reduced-layout-result.md`, original CR findings, docs/expo-router.md and docs/explorer-sidebar.md. App typecheck log `/tmp/fp1-fp13-typecheck.log` and fixer report record successful gate; no commands were rerun. Root owns final finding statuses and integrated gates.
