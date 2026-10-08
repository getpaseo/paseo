# New workspace worktree QA

Verified on October 6, 2026 with checkout source version 0.11.0-beta.5, isolated real daemons and Chromium through the existing Playwright harness. The installed client and host on port 6767 were not used or restarted. Ryan reviewed the disposable preview and requested the combined branch picker, field order, Local branch label and explicit search placeholder.

## Coverage

- Real Git workspace transport: existing-branch checkout, named branch-off from an explicit base, independent exact directory names, occupied branches, invalid names, branch/directory collisions, concurrent directory collision, external and managed checkout adoption, and missing worktree registrations. Adoption leaves `git worktree list` unchanged.
- Form model: sanitized defaults, manual name retention across mode/ref changes, capability requirements, invalid names and branch occupancy.
- Provisioning: adopting a checkout retains known fork automation restrictions, including archived records and subdirectories.
- Browser at 1440 × 1000 and 390 × 844: both creation modes, exact actual Git branch, existing checkout adoption, invalid-name and collision failures retaining edits, field order and branch-picker prefixes. Additional cases cover enumeration loading/retry, Local branch labels and repository-scoped branch choices.

## Results

Ran only focused test files/cases. No full local test suite was run.

```text
npx vitest run packages/app/src/screens/new-workspace/worktree-form-model.test.ts packages/app/src/screens/new-workspace-picker-state.test.ts --bail=1
Test Files  2 passed (2)
     Tests  24 passed (24)

# From packages/server:
npx vitest run src/server/workspace-create-worktree-source.e2e.test.ts src/server/session/workspace-provisioning/workspace-provisioning-service.test.ts --bail=1
Test Files  2 passed (2)
     Tests  52 passed (52)

# Repeated only the transport file after adding the missing-registration regression:
npx vitest run src/server/workspace-create-worktree-source.e2e.test.ts --bail=1
Test Files  1 passed (1)
     Tests  10 passed (10)

PLAYWRIGHT_BROWSERS_PATH=/tmp/paseo-worktree-playwright npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/new-workspace.spec.ts --grep 'new worktree options|new worktree branch choices|Local shows'
3 passed, 2 failed (selectors also matched sidebar entries)

# After narrowing those selectors, repeated only the two affected cases:
PLAYWRIGHT_BROWSERS_PATH=/tmp/paseo-worktree-playwright npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/new-workspace.spec.ts --grep 'new worktree options create.*1440|new worktree branch choices'
2 passed (1.2m)

npm run build:server
exit 0
npm run build --workspace=@getpaseo/server
exit 0
npm run typecheck
exit 0
npm run lint
Found 0 warnings and 0 errors.
npm run format
exit 0
npm run format:check
All matched files use the correct format.
git diff --check
exit 0
```

The first browser attempt timed out during cold Metro warmup before running tests. The unchanged cached retry started successfully. All five selected browser scenarios passed across the retry and the final affected-case run.

### PR review follow-up

The repository-switch model regression failed before the fix: checkout mode and its derived directory name survived the new scope.

The cleanup safety claim from earlier revisions was disproved on Linux with Git 2.43.0. Deterministic interleavings captured an occupancy snapshot, then successfully adopted the failed branch through ordinary `git switch` and `git worktree add --no-checkout` while its ref lock was held. Cleanup subsequently deleted the adopted branch in both cases. Locking a branch does not exclude another checkout's HEAD update. A three-second successful reference-transaction hook also reproduced the preparation timer retaining a branch after removing its checkout.

Ryan approved retain-and-retry recovery. Synchronous exact-name setup failures now retain both checkout and branch, preserve command errors/results, and identify the checkout to recover. Retry runs setup on that path; fresh creation continues to reject branch and directory collisions. The branch-deletion transaction and acknowledgement timeout are removed. Tests verify slow deletion hooks and buffered transaction replies are never involved in setup failure. The buffering fixture simulates historical Git around real Git 2.43.0; no older Git binary or Windows runtime was tested.

Additional focused verification after addressing the review:

```text
npx vitest run packages/app/src/screens/new-workspace/worktree-form-model.test.ts --bail=1
Test Files  1 passed (1)
     Tests  11 passed (11)

# From packages/server:
npx vitest run src/utils/worktree.test.ts src/utils/worktree.posix.test.ts --bail=1
Test Files  2 passed (2)
     Tests  75 passed | 1 skipped (76)

# Focused lifecycle and strengthened collision/retry cases:
npx vitest run src/utils/worktree.test.ts src/server/worktree-session.test.ts --bail=1 -t 'exact setup failures|keeps the workspace available|run setup clears|emits completed when reusing'
4 passed

# After adding asynchronous same-checkout retry assertions:
npx vitest run src/server/worktree-session.test.ts --bail=1 -t 'keeps the workspace available'
1 passed

PLAYWRIGHT_BROWSERS_PATH=/tmp/paseo-worktree-playwright npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/new-workspace.spec.ts --grep 'new worktree options|new worktree branch choices'
3 passed, 1 failed (desktop case during live recompilation)

# Extended the Local failure-isolation case and repeated desktop against stable source:
PLAYWRIGHT_BROWSERS_PATH=/tmp/paseo-worktree-playwright npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/new-workspace.spec.ts --grep 'new worktree options show|new worktree options create.*1440'
2 passed (2.7m)

npm run build:server
exit 0
npm run typecheck
exit 0
npm run lint
Found 0 warnings and 0 errors.
npm run format
exit 0
npm run format:check
All matched files use the correct format.
```

All four selected browser scenarios passed across these runs. Real WebSocket request counts confirmed no worktree enumeration on initial Local display or Local submission. After a failed listing, choosing Local hid the listing error and still created the workspace. The repository-switch case reset to New branch, retained a typed directory name, and created the branch only in the newly selected repository. The compact creation/reuse case passed as well.

Real Git tests verify retry on the retained checkout, original failure details, exact-name collision rejection, preservation of pre-existing branches and setup commits, and preservation of branches adopted by ordinary switching or a new checkout without checkout/reset. New workspace uses asynchronous setup; focused lifecycle tests verify retained failures, recovery on the same checkout and existing-worktree reuse. This follow-up changes synchronous exact-name recovery only. No additional UI, native, Windows or Electron verification was performed.

## Visual evidence

- [New branch on desktop](new-branch-desktop.png): explicit branch intent, `from` base picker and worktree name before branch name. This capture also shows the retained validation error after correcting an invalid worktree name, before resubmission.
- [Existing branch on desktop](existing-branch-desktop.png): no base picker or new-branch field.
- [Existing branch at compact width](existing-branch-compact.png).
- [Local current branch](local-desktop.png).

## Platform limits

| Surface                                       | Coverage                                         |
| --------------------------------------------- | ------------------------------------------------ |
| Browser desktop layout                        | Real Chromium and isolated source daemon         |
| Browser compact layout                        | Real Chromium at 390 px; not native verification |
| Android                                       | Not verified; no attached ADB device             |
| iOS                                           | Not verified                                     |
| Electron wrappers on Linux, Windows and macOS | Not verified                                     |

The upstream contribution is cherry-picked onto upstream `main`. All changed feature files match the locally tested commit; unrelated local modifications are excluded. Broader integration on upstream and the unverified platforms remains for CI and additional device QA.
