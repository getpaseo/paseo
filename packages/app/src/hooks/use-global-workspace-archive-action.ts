import { useActiveWorkspaceArchive } from "@/hooks/use-active-workspace-archive";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";

const WORKSPACE_ARCHIVE_ACTIONS: readonly KeyboardActionId[] = ["workspace.archive"];

// The archive shortcut used to live on the sidebar row, so it did nothing whenever the row was not
// rendered — a collapsed project or status group, a collapsed Pinned section, or focus mode. Like
// the pin shortcut (see use-global-workspace-pin-action.ts), it is one registration keyed on the
// active route selection.
export function useGlobalWorkspaceArchiveAction() {
  const { canArchive, archive } = useActiveWorkspaceArchive();

  useKeyboardActionHandler({
    handlerId: "workspace-archive-global",
    actions: WORKSPACE_ARCHIVE_ACTIONS,
    enabled: canArchive,
    priority: 0,
    handle: archive,
  });
}
