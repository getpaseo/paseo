# Shared ordering QA

Validated on macOS on 2026-10-17 after merging fixed upstream `main`
`98559bf729ad558bc70035725c8400b5761bbf04` into the PR history.

## Application workflow

`packages/app/e2e/browser/sidebar-reorder.spec.ts` uses an isolated real daemon and
two independent Chromium contexts. The compact context receives connection settings
only; its client identity, layout, and order caches are independent. Port 6767 is
blocked. Its disconnect helper forwards frames to the real daemon and closes both
physical WebSocket ends for offline checks; it does not replace protocol responses.

The flow covers desktop and compact workspace drags, reverse compact drags, tab
ordering, reload, and Pinned order. The compact device then disconnects and drags a
Pinned row: the desktop remains unchanged while it is offline and receives the
queued move after reconnect.

```sh
/usr/bin/lockf -k /tmp/paseo-pr-followup-validation.lock npm run test:e2e --workspace=@getpaseo/app -- sidebar-reorder.spec.ts --workers=1 --retries=0
```

```text
2 passed (29.2s)
```

## Focused automated checks

Each file runs separately under the same validation lock. No full test suite runs.

| File                                                     | Contract                                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/src/ordering/replica.test.ts`                       | Exact moved key, untouched pairs, 70 queued gestures, pre-snapshot folding, conflict retries, late acknowledgements and reconnect               |
| `app/src/ordering/index.test.ts`                         | Cold cache, capability gate, before-connect intent, moved-host isolation and split-pane publishing                                              |
| `app/src/runtime/directory-sync/index.test.ts`           | Ordering failure leaves labels independently connected                                                                                          |
| `server/src/server/ordering/index.test.ts`               | Atomic disk writes, live prune loader, inventory reload, offline last-holder retention, principal isolation and epoch fencing                   |
| `server/src/server/ordering/index.e2e.test.ts`           | Real clients and daemon, exact offline moves, file/browser inventories, stale revisions, subscription teardown, pin/archive and explicit forget |
| `server/src/server/session.test.ts` (ordering case only) | Real Session authorization and ordering service: distinct admitted principals, viewer write refusal and stale-source rejection                  |
| `protocol/src/ordering.test.ts`                          | Existing snapshots remain parseable and target requests cannot select principal/client namespaces                                               |

The session authorization case uses the existing adapters for unrelated agent and
checkout dependencies; it does not mock Session authorization, ordering, delivery,
or filesystem persistence. The daemon integration uses the actual WebSocket client,
server protocol, and ordering service. The existing sidebar/layout/supporting-view
and localization files also pass their targeted checks.

```sh
npm run build:server
npm run format
npm run typecheck
npm run lint
```

All exit 0. Full command output, retries, browser screenshots and execution metadata
are retained in the implementation report's `/tmp` evidence directory.

## Coverage boundary

| Surface                              | Exercised                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| macOS daemon and WebSocket API       | Isolated real daemon and independent clients                                      |
| Chromium desktop and compact layouts | Real drag, reload and physical disconnect/reconnect                               |
| Split-pane exact move                | Store/controller and operation tests; real daemon receives the same move contract |
| Native iOS / Android                 | Not exercised                                                                     |
| Packaged Electron / Windows / Linux  | Not exercised                                                                     |

Compact browser evidence does not establish native mobile acceptance. Ordering does
not open or close another device's tabs or move its focus or pane membership.
File/browser targets use the same complete shared scope. Cross-host interleaving and
project-header ordering remain local. Inventory retention and explicit forget follow
[the persistence contract](../../data-model.md#shared-ordering).
