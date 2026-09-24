# CR2 — Verify the merge with paseo-customizations

Date: 2026-09-24. Current dispositions remain in [the fix ledger](FIXES-introduce-pr-diff-chapters.md).

## Scope and decision

This is a focused integration review of the merge of `160430f9452ab32c7b75b35d1ee5158d1f953c89`
(`origin/paseo-customizations`) into `ff66c741b` (`introduce-pr-diff-chapters`, fixes committed and pushed).
The full feature range is the merged candidate versus that incoming parent. Review concentrated on
15 files changed on both sides, their consumers, and the five explicit conflict resolutions.
The earlier branch review and reduced-scope decisions remain in CR1 and the ledger. This is not
a new exhaustive review of the incoming branch or a reopening of deferred personal-fork scope.

Three independent reviewers covered correctness/frontend, correctness/reliability/API contracts,
and testing/maintainability/project standards. One new integration defect was found and corrected.
Final readiness depends on the validation results recorded below.

## Finding

| ID    | Issue                                                                                                                                                                                                                                                                                                                                                                                                                                     | S/F → P    | Confidence | Original gate          |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------- | ---------------------- |
| CR2-1 | **Unchanged chapter reviews become falsely stale.** New live-file language eligibility metadata changes when TypeScript files are edited, even when a committed comparison is unchanged. Hashing it marks the chapter story stale and disables inline review comments.<br>`packages/server/src/server/chapters/service.ts:32`, `packages/server/src/server/code-language/diff-snapshot.ts:53`, `packages/app/src/chapters/panels.tsx:139` | S2/F2 → P2 | 100        | blocks until corrected |

**Impact:** a single user editing a compared TypeScript file can lose comment editing in an otherwise
current base comparison. The stale-story UI makes this recoverable through regeneration, but adds
unnecessary model work. **Invariant:** chapter freshness tracks compared source, independently of
language-navigation eligibility. **Checked:** the language identity is intentionally conditional on
the live file matching the target; the existing fingerprint excluded tokens but not this new field;
the stale guard disables review actions. **Proof:** the new real-service regression failed on unequal
fingerprints before the fix. It passes for both removal and change of the identity, retains the old
story without regenerating, and still invalidates after a real hunk-content change. **Fix:** exclude
`targetContentId` beside `tokens` in the single fingerprint owner. Language-query identity validation
is unchanged. **Closure:** independent server reviewer explicitly verified the exact correction,
neighboring safety guards, and red/green evidence. See the ledger for current status.

## Conflict resolutions and maintenance

- Compact Explorer, daemon client, and server session each had a leading-import collision. Both
  features' imports and handlers are preserved.
- Sleep inhibitor runtime and test files take the incoming versions. They already contain the same
  live config subscription/disposal correction and extend it with helper-loss notifications and tests.
- The auto-merged diff surface exceeded the existing complexity limit by one. Removing a redundant
  working-mode check is equivalent because `reviewActions` is already absent for other modes.
  The independent app reviewer checked this equivalence; no abstraction or state was added.
- Installed four incoming language-server dependencies. Discarded npm's unrelated lockfile rewrite,
  preserving the incoming committed lockfile. Rebuilt workspace declarations before type checking.

## Verification

- Focused server regressions: 26 passed (7 chapter service, 15 sleep inhibitor, 4 language diff snapshot).
- Focused app regressions: 37 passed (persisted layouts, diff hit testing, file-open command and model).
- Chapters client/server transport: 1 passed against an isolated real daemon.
- Full server dependency-stack build: passed.
- Browser: 5 passed (real TypeScript hover/definition/usages, working-diff eligibility, compact Changes,
  response naming retry, and summary badge running/file/completed behavior).
- Whole-workspace typecheck and lint: passed. Formatting and diff checks: passed before commit.
- Total focused cases on the merged candidate: 69. Unchanged prior cases were not repeated.
- Browser used installed Chromium shell 1234 through a temporary config (trace/video off); the temporary
  config was removed. Expected shell 1208 was unavailable on this host.
- CI validation follows the pushed merge commit. Local readiness: ready within the approved scope;
  broad CI result is still pending at this record's merge commit.

[Evidence and independent reports](evidence/merge-paseo-customizations/) identify the exact parent
commits and product patch hash. No main daemon restart, full local suite, commit to the target
branch, or final feature merge into paseo-customizations is part of this work.

## Remaining findings and limits

No other new issue was found in the inspected integration seams. No unresolved review finding
remains after the CR2-1 correction; readiness still requires the stated validation.
Prior deferred findings retain their existing disposition. Native/device rendering, live-provider
sandbox enforcement, and full incoming feature coverage are not established by this focused review.
