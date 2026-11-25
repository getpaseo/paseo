export {
  archiveWorkspaceWithUndo,
  archiveWorkspacesWithUndo,
  hasUndoableWorkspaceArchive,
  undoLatestWorkspaceArchive,
  type UndoableWorkspaceArchiveClient,
  type UndoableWorkspaceArchiveEntryInput,
  type WorkspaceArchiveBatchFailure,
  type WorkspaceArchiveBatchResult,
} from "./internal/undo-window";
export { WorkspaceArchiveUndoShortcutHost } from "./internal/undo-shortcut-host";
export { supportsWorkspaceArchiveUndo } from "./internal/capability";
export { useWorkspaceArchiveUndoRunning } from "./internal/use-workspace-archive-undo-running";
