# Manual shared ordering validation — 2026-10-24

Source: PR #6737 after merging frozen upstream
`b8bb335c563279be45544b1b20a1fa5b3e56d422` into original head
`14577138a0646bd64f07fac6855ae3bd46254403`. The source and these artifacts ship in
one commit; the PR body identifies its final SHA. Provider/model: OpenAI / `gpt-6.1-sol`.

Text artifacts remove ANSI escapes and trailing spaces; unmodified originals remain
in the local worktree's `.dev/ordering/` directory.

## Executed checks

[Raw build, test, formatting, typecheck, and lint output](validation.txt).
Each Vitest file ran separately with `--bail=1 --maxWorkers=1`; no full suite ran.

| File under `packages/`                                     | Executed cases |
| ---------------------------------------------------------- | -------------: |
| `app/src/ordering/index.test.ts`                           |             21 |
| `app/src/ordering/replica.test.ts`                         |             15 |
| `app/src/ordering/layout.test.ts`                          |              4 |
| `app/src/stores/sidebar-order-store.test.ts`               |             10 |
| `app/src/stores/session-store-hooks/selectors.test.ts`     |             21 |
| `app/src/hooks/sidebar-workspaces-view-model.test.ts`      |             42 |
| `app/src/stores/workspace-layout-store.test.ts -t reorder` |              3 |
| `app/src/runtime/directory-sync/index.test.ts`             |             33 |
| `server/src/server/ordering/index.test.ts`                 |              7 |
| `server/src/server/ordering/index.e2e.test.ts`             |              6 |
| `server/src/server/session.test.ts -t ordering`            |              1 |

All 163 executed cases passed. The layout and Session subsets left 160 and 149
unmatched cases unexecuted. `npm ci` (including patches/prepare), `npm run build:server`,
audio declarations, `npm run format`, root `npm run typecheck`, and root `npm run lint`
exited zero. Source commits use normal hooks.

## Real browser flow

```sh
E2E_RECORD_VIDEO=1 npm run test:e2e --workspace=@getpaseo/app -- sidebar-reorder.spec.ts --workers=1 --retries=0
```

[Final raw browser output](browser.txt): **5 passed (1.4m)** on macOS Chromium,
using a real isolated daemon and independent desktop/compact contexts. The run
started at 11:09 UTC. It covers Manual workspace order in both directions, tab and
Pinned drags, reload, offline Pinned replay, pre-beta Manual migration, switching
between automatic and Manual modes, and active overflow. The harness reserves and
blocks installed-daemon port 6767.

- [Desktop tabs and Manual workspace order](desktop-shared-tab-order.png)
- [Compact tabs](compact-shared-tab-order.png)
- [Compact Manual workspace order](compact-shared-workspace-order.png)
- [Compact Pinned order](compact-shared-pinned-order.png)
- [Compact offline move](compact-offline-shared-pinned-order.png)
- [Desktop interaction recording](video.webm)

The compact context uses the harness's existing developer-toast CSS treatment;
console output remains in the raw logs. Its Display sheet is closed before capture.

## Failed attempts and limits

[The initial browser attempt](browser-attempt1.txt) passed four cases and timed out
opening the Display menu immediately after a drop. Dnd-kit's pointer sensor keeps
click suppression for 50ms after release. The test now uses keyboard menu interaction
instead of timing sleeps. Failed trace/video remain in the local worktree's
`.dev/ordering/browser-results-attempt1/`; they are not part of this directory.

The raw validation output also retains the initial read-only test-cleanup failure,
the directory fake's missing observer port, the duplicate test-object `serverId`, and
the shadowed callback lint error. Their passing results follow their failed attempts.

Seed-project teardown emits `Workspace is not active` target-inventory errors;
these are retained rather than suppressed. Passing flow assertions do not establish
a clean console or resolve that cleanup race.

Native iOS/Android, packaged Electron, Windows/Linux, and external Hub authentication
were not exercised. Store/operation tests do not establish native gesture acceptance.
The offline queue survives socket reconnect in the running process, not application
termination. Persistence/authority ownership is described in
[the shared ordering contract](../../../data-model.md#shared-ordering).
