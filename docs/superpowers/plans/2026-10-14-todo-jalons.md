# To-do Jalons Implementation Plan

**Goal:** Integrate the user-approved Jalons design as a full-height column immediately after workspace navigation.

**Architecture:** Keep the existing workspace To-do host, subscriptions, mutation queue and draft ownership. Add optional milestone labels to tasks; group by first occurrence without deriving semantic groups from text. Render active tasks first and collapse completed history within each milestone. Keep the compact sheet and the same cross-platform content.

**Tech Stack:** React Native, Unistyles, Zod, existing daemon/client observation APIs.

**Spec:** User-approved `packages/app/src/workspace-todos/column-alternatives/TodoAlt6Jalons.web.tsx` and screenshot `artifacts/todo-columns/06-jalons.png`.

## Constraints

- Keep old task files and wire messages parseable. Gate new functionality with `workspaceTodoMilestones`.
- Protect user-edited milestone assignments like titles and notes; agents can still update status.
- Do not restart port 6767. Preserve the unrelated interactive-response work in this checkout.
- Retain the comparison until cleanup is explicitly requested.
- Local delivery requires publication, installation and active identity verification; report any gate blockers.

## Implementation

- [x] Extend `packages/server/src/server/workspace-todos.test.ts` with persistent milestone initialization, updates, manual protection, old task loading and conflict checks. Run the file to show the new field is not preserved, then add optional fields to `packages/protocol/src/workspace-todos.ts` and normalize milestone text in the store. Add the capability in `messages.ts` and `websocket-server.ts`; describe assignments in the existing agent tool.
- [x] Replace the floating host presentation in `packages/app/src/workspace-todos/index.tsx` with a dock before its children, leaving the compact sheet. Implement grouped progress, wrapped read-only titles, detail editing, per-group completed disclosure and the add form. Preserve drafts across status updates and regrouping. Keep global task order intact when dragging within a visible subset.
- [x] Update `packages/app/e2e/browser/workspace-todos.spec.ts` for docking geometry, persisted milestones, notes/title editing, ordering, completed disclosure, compact conflicts and reconnect draft preservation. Use the existing isolated daemon/Metro fixtures and screenshot the actual screen.
- [x] Update the owning shared To-do section in `docs/data-model.md`, rebuild workspace declarations, run targeted tests plus root typecheck/lint/format, and review only this change against the approved mockup.
- [x] Inspect the complete-source gate and prepare local delivery without modifying unrelated unfinished work or restarting the main daemon.

## Review focus

- Old tasks without milestone data must remain visible under À organiser.
- Task completion or remote reassignment must not discard an open edit draft.
- Subset drag ordering must contain every original task ID once.
- Narrow layouts must preserve a usable center pane; compact uses its existing sheet.
- Disconnected/conflicting mutations must keep editable text and an actionable retry.

## Delivery status

Implementation and local checks are complete. Publication, installation and active-version verification remain pending: the delivery will preserve OpenUI in a separate commit, disabled by default, then audit the combined candidate. See `docs/qa-evidence/todo-jalons-2026-10-14.md`.
