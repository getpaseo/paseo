import { useGlobalWorkspaceArchiveAction } from "@/hooks/use-global-workspace-archive-action";

// Headless host for the archive shortcut, kept out of the root layout for the same reason as
// WorkspacePinShortcutHandler: the hook subscribes to the active workspace's fields.
export function WorkspaceArchiveShortcutHandler() {
  useGlobalWorkspaceArchiveAction();
  return null;
}
