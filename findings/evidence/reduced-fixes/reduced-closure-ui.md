# Fresh read-only UI verification — reduced scope

Reviewer did not implement these UI changes and ran no tests. Inspected actual production call paths, relevant sibling render paths, current diff and test harness. Root owns final finding status and browser proof.

## Candidate

Uncommitted patch over 23cb8e83c, inspected 2026-09-22. Product file SHA256 values at review:

- `message.tsx`: 6d8125b7b74e66f36bfe20418dc3f349591f36e5749ece19b6093ba0f805cbc1
- `tool-calls/summary-label.tsx`: 9a4182f0802b9d8772914f85fc11d1c635f59063ec7ca65a1e532e849bb84004
- `prevent-sleep-card.tsx`: 2071e3c3f3153feffd84acd808d19b49c8773f9cda132610531c476781fca25b
- `workspace-recent-agents-menu.tsx`: 62463d4d6483c9d7bc82a0960b1d20b6505b417672165eefb9ec866ca3aaf48a
- `e2e/support/helpers/workspace-ui.ts`: 03401164a6e862c85630680efc34402e26bc3e8bf3371868cf05ab20bb62a43b

## FP5 / CR1-4 — retain running appearance and file controls around summary labels

Static assessment: corrected, no remaining concrete defect identified in inspected paths. Browser lifecycle result pending root. Native rendering not executed.

`ToolCall` still derives generated or fallback input labels via `buildToolCallPresentation`. `ExpandableBadge` now always renders `ExpandableBadgeLabelRow`, rather than letting summary content replace it. The custom renderer substitutes the label only; running measurements, web overlay/native mask, secondary text and file button remain owned by the existing badge. Running/executing suppresses output summary as before and receives the badge loading appearance. Completion clears isLoading and therefore removes shimmer while restoring input/output summary presentation. Details toggle and separate open-file handler still stop propagation; file button remains hover-visible on web and is now reachable on native. Calls without a summary renderer still render the original label/secondary path. PlanCard early return is unchanged.

Fresh inspection initially found two integration defects: native mask used raw unshortened label despite visible basename substitution/eight-word compaction, and injected badge text style overwrote summary `flexShrink:1` with `0`. Root corrected both before this report. Reinspection confirms both native mask and web overlay invoke the same summary renderer as visible text, reserve matching file-button width, and omit the plain-label spacer for already-flexing summary rows. Final inputLayout style preserves shrink and min-width. Measurements remain within existing shimmer state, with no new timer/controller/cache.

Maintenance tradeoff matches agreed scope: one existing prop changes from ReactNode to a narrow label renderer, plus appearance/layout props on ToolCallSummaryLabel. Existing web/native shimmer structures remain authoritative. Additional lines mostly pass that renderer through the existing paths. No full raw-command row, provider policy change, duplicate running indicator, or new subscription owner added.

Proof boundary: the initial standalone Vite browser test could not import message.tsx because an existing native dependency exposes Flow JS; this is harness incompatibility, not a failing UI assertion. Root is replacing that attempted test with a real app Playwright case and a narrow existing mock-provider fixture extension, avoiding transport mocks and module-stub infrastructure. `/tmp/reduced-shimmer-e2e.log` result pending.

## FP12 / CR1-22 — show sleep switch only after config exists

Static assessment: PASS for the small load-state guard; UI runtime proof not executed by reviewer.

`useDaemonConfig` returns `MutableDaemonConfig | null`, resolving unavailable query data to null. `PreventSleepCard` now returns before rendering whenever config is null, so undefined data cannot be interpreted as enabled. Once data exists, absent optional flag still preserves the actual default-true semantics. Connection/capability gating, unsupported-host explanatory copy/disabled switch, patch mutation pending state and error copy are unchanged. No new loading state or duplicated configuration owner was introduced. Cached config behavior on reconnect remains the existing hook's behavior, outside this initial-load correction.

## FP16a / CR1-13 partial — request recent history only when its menu opens

Static assessment: PASS for lazy initial query; no claim that all hidden background subscriptions are stopped.

`WorkspaceRecentAgentsMenuContent` is a child of the existing DropdownMenu, which directly reexports MenuRoot. The context's open state therefore comes from the actual enclosing trigger/surface. `enabled: open` reaches `useAgentHistory` and its `useInfiniteQuery` enabled condition; manual refresh/load-more functions also respect enabled. Closed mounts no longer initiate history fetching; opening enables ordinary cached/stale React Query behavior. Existing recent selection, loading/error rows, show-all action and reopening logic are untouched. The hook still subscribes to runtime host state while mounted; accepted scope was deferred fetching, not a new subscription controller or feed lifecycle rewrite.

## CR1-8 — workspace helper must verify project identity

Static assessment: PASS for restoring the assertion's meaning; browser caller result pending.

Previous helper accepted any visible branch pair and skipped project-text verification when subtitle was absent. New assertion requires either exact visible subtitle or exact named project group containing the selected sidebar workspace with expected title. Inspected `WorkspaceHeaderProjectRow` (wide Git uses branch pair, compact uses subtitle), sidebar project group (`role=group`, displayName accessibility label), workspace selected-row aria-selected and title, plus representative sidebar/new-workspace/navigation test callers. Wrong project title can no longer pass merely because a branch pair exists. Existing header title and optional branch assertions are preserved.

Utility limit: wide fallback requires the project-group sidebar to be visible and expanded, as inspected callers arrange. It intentionally fails rather than silently skipping identity if a future caller hides that sidebar or changes grouping. No production UI changes added for the helper.

## Disposition

No unresolved concrete regression found after root's mask/layout corrections. FP5 and CR1-8 still await actual browser evidence; no blanket verified-closed claim based on inspection alone. FP12 and FP16a local predicates and consumer wiring are affirmative static evidence, with no dedicated delayed-config/network-count test reported yet. Root should preserve these runtime limits in the ledger.

## Browser evidence addendum — final tested candidate

Inspected raw root-run logs `/tmp/reduced-browser-final.log` and `/tmp/reduced-scripts-browser-final.log`; reviewer did not rerun tests. The three UI implementation SHA256 values for message.tsx, summary-label.tsx and workspace-ui.ts still match the candidate recorded above.

Root command:

```
npm run test:e2e --workspace=@getpaseo/app -- --config reduced-playwright.config.ts tool-call-shimmer.spec.ts workspace-package-scripts.spec.ts new-workspace.spec.ts -g 'a summary label keeps|nested package scripts run|sidebar workspace navigation updates'
```

Used a temporary Playwright config selecting installed Chromium headless shell revision1234 because default revision1208 installation stalled; normal real Metro/app/daemon fixture remains. No transport rewriting in the new badge test. Initial combined run: header scenario PASS (3.8s), badge scenario PASS (7.5s), package-script scenario failed on a newly added incorrect test selector. `ScriptGroup` renders a plain label for the sole surviving package (`packageCount > 1` controls collapsibility), so expecting a collapsible root group was an erroneous test assumption. Root removed that selector and click, preserving direct healthy-script visibility, no-Retry, and repaired nested-script rediscovery assertions. This repairs the test to assert actual intended behavior rather than weakening the guarantee.

Final isolated command:

```
npm run test:e2e --workspace=@getpaseo/app -- --config reduced-playwright.config.ts workspace-package-scripts.spec.ts -g 'nested package scripts run'
```

PASS, one case 4.5s / 12.4s total in `/tmp/reduced-scripts-browser-final.log`.

### FP5 final verdict: PASS for browser running/completion/file-control guarantee

Inspected new real-app case in tool-call-shimmer.spec.ts and the mock provider extension. Existing five-second foreground-shell fixture optionally emits the explicitly requested `cat` command instead of `sleep 5`; it does not execute arbitrary prompt commands and leaves default fixture behavior unchanged. Test passes an absolute real fixture README path. This exercises `buildInputLabel`'s normal fallback read label, which enters exactly the same ToolCallSummaryLabel/badge custom-renderer path used by generated input labels, without invoking another vendor or injecting synthetic network messages.

Browser proof asserts visible input `Read README.md`, active shimmer containing that exact text with nonzero rendered width, actual file button click opens README workspace tab, completed agent returns to its timeline with zero shimmer and file control still visible. This is affirmative evidence for the original label-row bypass regression and neighboring file navigation/completion behavior. It does not test LLM text generation, native mask pixels, or longest-label truncation on a device. Native shared-renderer correction and shrink ordering remain inspected structural evidence only.

### CR1-8 final verdict: PASS for exercised wide project identity path

Real app new-workspace scenario switches between sidebar workspaces and verifies route/header with the repaired helper. Combined-run PASS validates its new selected-project group locator in the intended wide UI. Exact project label remains part of the locator; branch-pair presence alone cannot satisfy it. Compact subtitle and hidden/status-group sidebar variants were inspected where applicable but not executed in this run.

### Remaining limits unchanged

No delayed-config timing browser test or network request-count test was supplied for FP12/FP16a. Their local predicates and authoritative consumer wiring passed static inspection; do not relabel those as executed timing proofs. Native rendering remains unexecuted. No unresolved concrete UI defect found in current inspected/tested scope.

Additional tested-file hashes:

- tool-call-shimmer.spec.ts: 66cec83676dc1ffa551073d820351e28043182842f3cac62cd28ccbdd970269a
- workspace-package-scripts.spec.ts: b4d5e374e8a9fbe8458950737a58a2bebb836768e6149acb1c7bf0732678de48
- mock-load-test-agent.ts: 4b7bc75d27807f92f90be260fbe03c9488ada6407dd46f70e2d7a754b772d114
