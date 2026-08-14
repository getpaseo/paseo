# Commit Tracker - 5963e1d5

Session: 2026-08-14 14:34 (paseo fork)

## Changes

| Time  | File                                                                | Action | What Done                                                              |
| ----- | ------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------- |
| 14:15 | packages/server/src/utils/nested-checkout-scan.ts                   | add    | Depth-2 checkout scan. Hidden dirs included. Branch+worktree resolved. |
| 14:15 | packages/server/src/utils/nested-checkout-scan.test.ts              | add    | 8 tests. Real git worktrees.                                           |
| 14:16 | packages/server/src/server/session.ts                               | edit   | Scan handler uses new util. Old 1-level scan gone.                     |
| 14:19 | packages/app/src/components/sidebar/nested-repos-section.tsx        | edit   | Row shows branch + icon.                                               |
| 14:21 | packages/protocol/src/messages.ts                                   | edit   | fs.content_search RPC. fsContentSearch feature gate.                   |
| 14:21 | packages/server/src/server/websocket-server.ts                      | edit   | Advertise fsContentSearch capability.                                  |
| 14:22 | packages/server/src/server/file-explorer/content-search.ts          | add    | git grep + walk fallback. Capped 500.                                  |
| 14:22 | packages/server/src/server/file-explorer/content-search.test.ts     | add    | 9 tests. Parser colon-paths covered.                                   |
| 14:23 | packages/server/src/server/session/files/workspace-files-session.ts | edit   | Content search handler.                                                |
| 14:24 | packages/client/src/daemon-client.ts                                | edit   | searchFileContents RPC method.                                         |
| 14:26 | packages/app/src/stores/panel-store/index.ts                        | edit   | Per-workspace search open flag. Not persisted.                         |
| 14:27 | packages/app/src/keyboard/actions.ts                                | edit   | file.search action id.                                                 |
| 14:27 | packages/app/src/keyboard/keyboard-action-dispatcher.ts             | edit   | file.search definition.                                                |
| 14:27 | packages/app/src/keyboard/keyboard-shortcuts.ts                     | edit   | Cmd/Ctrl+L binding + help row.                                         |
| 14:28 | packages/app/src/hooks/use-global-file-search-action.ts             | add    | Global Ctrl+L handler. Capability gated.                               |
| 14:29 | packages/app/src/components/content-search-panel.tsx                | add    | Search panel. Accordion per file. Highlight.                           |
| 14:31 | packages/app/src/components/content-search-highlight.ts             | add    | Pure segment splitter.                                                 |
| 14:31 | packages/app/src/components/content-search-highlight.test.ts        | add    | 4 tests.                                                               |
| 14:29 | packages/app/src/components/file-explorer-pane.tsx                  | edit   | Mount search panel above tree.                                         |
| 14:30 | packages/app/src/app/\_layout.tsx                                   | edit   | Register global file-search action.                                    |
| 14:30 | packages/app/src/i18n/resources/\*.ts (9)                           | edit   | Search strings all locales.                                            |
| 14:32 | packages/protocol/src/messages.content-search.test.ts               | add    | 6 schema tests.                                                        |
