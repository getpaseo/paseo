# Integration review: testing, maintenance, and project standards

No new merge-specific defect or maintenance blocker found in the inspected overlap. This is a read-only assessment; no tests, installs, builds, or static gates were run by this reviewer. Merge readiness still depends on the orchestrator's current-candidate checks.

## Candidate and scope

Base HEAD: `ff66c741b`. Incoming: `160430f9452ab32c7b75b35d1ee5158d1f953c89`. Common ancestor: `f777bc1b38090a427fe64b723e4df6303d31f7d4`. Reviewed staged binary patch SHA-256: `edd624663f6a62e266ab205a5006bb88506916916edf99e2937a6fdad42f9cc6`.

Inspected all 15 paths modified on both branches, concentrating on the three additive import conflict resolutions, the sleep runtime/test resolution, the retained chapter/background layout variants, read-only chapter rendering, shared session/client dispatch, and Git ownership changes. Also inspected incoming package/lock additions and desktop packaging declarations as the integration dependency boundary. Followed the shared review contract, repository instructions, testing/coding standards, protocol compatibility, and ROUND-2 of `findings/FIXES-introduce-pr-diff-chapters.md`. No deferred findings are reopened here.

## Affirmative source evidence

- The compact Explorer retains `ChaptersContent` and its chapter panel branch (`compact-explorer-sidebar.tsx:449`). Incoming location-aware opening wraps ordinary string paths at the Files/Changes adapters and forwards location requests separately (`:524`). The resolved imports support both independently retained consumers.
- The client retains `getChapters` (`daemon-client.ts:5110`) alongside incoming language RPC methods (`:4587`). The server retains chapter dispatch (`session.ts:2606`) and independently adds language dispatch (`:2752`) plus lifecycle cleanup. No duplicate dispatch case or lost branch was found.
- The sleep runtime and its test file are byte-for-byte identical to incoming. That resolution subsumes our approved mid-run configuration fix: `onChange(evaluate)` remains at `sleep-inhibitor/index.ts:180`, and both config and backend listeners are removed at `:194–195`. Tests retain setting disable/re-enable while an agent stays running (`index.test.ts:215`) and unsubscribe assertions (`:318`). Incoming backend notifications publish state rather than calling evaluate recursively; acquire/release callbacks therefore do not create an acquisition feedback loop.
- Persistence keeps background and chapter target variants while adding optional file columns. The strict target schema accepts the combined target shapes. The existing storage-injection seam remains the single persistence owner. No new migration or parallel persisted representation is introduced by the merge.
- Incoming language interaction is enabled only for working-diff mode (`surface.web.tsx:78`). All three chapter read-only guards remain (`:729`, `:851`, `:962`). The chapter feature's comment behavior is preserved by inspection.
- Git's configured-worktree ownership correction remains intact; incoming language snapshot work occurs in `getCheckoutDiff`, independently of that ownership decision. The new helper dependency is narrowly scoped content/snapshot code, with no observed dependency cycle back into checkout Git.
- `package-lock.json` adds precisely the declared production language-server and protocol dependencies plus their two transitive packages. TypeScript was already a server production dependency. Desktop `asarUnpack` includes both TypeScript subprocess trees. The packaging test establishes configuration intent only; it does not establish behavior inside a packaged app.

The maintenance tradeoff is bounded: the merge adds file-location adapters and one session-owned language lifetime while retaining the existing chapter and persistence owners. An ordinary change to chapter generation or background persistence does not acquire a new obligation to modify the language subsystem. No coordination cost justifies a refactor in this integration.

## Minimal verification recommendation

Run focused files once, in their owning workspace; do not run whole suites:

1. `packages/server/src/server/sleep-inhibitor/index.test.ts` proves the manually resolved runtime behavior, setting changes, and cleanup.
2. `packages/app/src/stores/workspace-layout-persistence.test.ts` proves the retained background persistence guarantee. Existing `workspace-layout-store.test.ts` chapter cases cover chapter ownership; select chapter cases if those have not already run on this candidate.
3. `packages/app/src/git/diff-document/hit-testing.test.ts` covers incoming source locations and existing review geometry. This does not execute React chapter read-only handlers.
4. `packages/app/src/workspace/file-open/index.test.ts` and `screens/workspace/workspace-file-open-command.test.ts` cover location ranges through shared opening commands.
5. `packages/server/src/server/code-language/diff-snapshot.test.ts` plus targeted structured/base-mode cases in `utils/checkout-git.test.ts` cover the modified shared diff path. The large Git file can be selected with `-t` to avoid unrelated network/forge cases.

Required typecheck/lint should follow installation and declaration builds. The three leading import conflicts themselves need static gates, not tests that assert import text. A real packaged desktop smoke would strengthen incoming feature evidence but is not needed solely to establish these additive conflict resolutions.

Historical ROUND-2 results apply to that earlier product snapshot. They explain intended guarantees and give useful prior evidence; they are not fresh integration results. Likewise incoming findings records do not substitute for this candidate's tests. Actual OS sleep, native UI, packaged language-server spawning, and live provider behavior remain unexecuted here. No unproven runtime regression is asserted from those limits.
