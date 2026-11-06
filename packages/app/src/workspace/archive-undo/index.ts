export {
  archiveWorkspaceWithUndo,
  undoLatestWorkspaceArchive,
  type UndoableWorkspaceArchiveClient,
} from "./internal/undo-window";
export { WorkspaceArchiveUndoShortcutHost } from "./internal/undo-shortcut-host";
export { supportsWorkspaceArchiveUndo } from "./internal/capability";
