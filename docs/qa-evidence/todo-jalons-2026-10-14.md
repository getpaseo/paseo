# To-do Jalons — local execution record

The user approved the Jalons alternative. The implementation is in this checkout; it has not been published, installed or activated.

## Behavior

- Desktop uses a full-height column immediately after workspace navigation. Compact layouts retain the existing sheet.
- Task titles wrap. Milestones show progress, keep unfinished tasks visible and collapse completed history.
- Optional milestone labels persist with tasks. Existing tasks appear under “À organiser”. User-edited assignments are protected independently from titles and notes.
- Drafts survive hiding, workspace switching, conflicts and reconnection. Reordering a visible subset preserves the global task list.
- `workspaceTodoMilestones` gates the feature. Older hosts show the update-host message.

## Validation

- Twelve targeted tests passed across `workspace-todos.test.ts` and `grouping.test.ts`: persistence, legacy files, protected fields, atomic conflicts, grouping and subset ordering. The new persistence test failed before implementation.
- Five browser scenarios passed using an isolated real daemon and Metro: desktop geometry, edit/reorder/history, compact conflict recovery, old-host capability, reconnect with an unsaved draft, and three milestones with long titles. The visual scenario was repeated after removing a transient workspace hover card from the capture.
- Root `npm run typecheck` and `npm run lint` passed. Changed files were formatted through npm scripts.
- `artifacts/todo-jalons/desktop.png`: actual browser desktop view, full-height placement, wrapped titles, completed milestone and active groups.
- `artifacts/todo-jalons/compact.png`: actual compact browser sheet with the preserved edited title. This is not a native-device screenshot.

The full iOS production bundle compiled successfully with `expo export --platform ios --max-workers 2` (Hermes output under `artifacts/todo-jalons/ios`, log `ios.log`). Android export, Electron and physical-device interaction were not checked.

## Delivery gate

The read-only source inventory found one blocker: this dirty checkout, containing both Jalons and unrelated unfinished OpenUI work. The audit is in `artifacts/todo-jalons/source-audit.json`. The delivery resolution preserves OpenUI in a separate commit, with the unfinished feature disabled by default at its capability, tool, prompt and RPC boundaries. Its code remains part of the candidate audited by the [complete-source gate](../paseo-local-auto-build.md#complete-source-gate). No source is hidden or discarded.

The main daemon on port 6767 was not restarted. Publication, installation and active-version verification remain pending. The shared Jalons task stays in progress until delivery is verified.
