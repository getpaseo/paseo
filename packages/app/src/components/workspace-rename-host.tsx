import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WorkspaceRenameModal } from "@/components/workspace-rename-modal";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";

const WORKSPACE_RENAME_ACTIONS: readonly KeyboardActionId[] = ["workspace.rename"];

/**
 * The rename dialog used to live only on the sidebar row, so it was unreachable whenever that row
 * was not rendered — a collapsed project or status group, a collapsed Pinned section, or focus
 * mode. This is the same fix `use-global-workspace-pin-action.ts` applies to pin: one registration
 * keyed on the active route selection.
 *
 * Sidebar rows keep their own modal instances. They rename *their* workspace, not the active one.
 */
export function WorkspaceRenameHost() {
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const routeWorkspaceId = selection?.workspaceId ?? null;
  // Narrow projection so the dialog doesn't re-render on every gitRuntime/diffStat tick.
  // `id` is projected rather than reusing the route id: the route carries an opaque workspace id
  // that is not guaranteed to equal the descriptor id, and setWorkspaceTitle needs the descriptor.
  const fields = useWorkspaceFields(serverId, routeWorkspaceId, (workspace) => ({
    id: workspace.id,
    name: workspace.name,
    title: workspace.title ?? null,
  }));
  const [isOpen, setIsOpen] = useState(false);
  const openFrameRef = useRef<number | null>(null);

  const cancelPendingOpen = useCallback(() => {
    if (openFrameRef.current !== null) {
      cancelAnimationFrame(openFrameRef.current);
      openFrameRef.current = null;
    }
  }, []);

  useEffect(() => cancelPendingOpen, [cancelPendingOpen]);

  // The command center closes and dispatches in the same React batch, so opening synchronously
  // would mount this modal while the palette is still unmounting — on Android the portal stacking
  // lands the dialog behind it, and on web the palette's teardown steals focus back from the
  // input. Wait a frame. (The caller has already cleared the focus-restore element.)
  const handle = useCallback(() => {
    if (!fields) return false;
    cancelPendingOpen();
    openFrameRef.current = requestAnimationFrame(() => {
      openFrameRef.current = null;
      setIsOpen(true);
    });
    return true;
  }, [cancelPendingOpen, fields]);

  const handleClose = useCallback(() => {
    cancelPendingOpen();
    setIsOpen(false);
  }, [cancelPendingOpen]);

  // Closing on workspace change avoids renaming whatever the user navigated to instead.
  useEffect(() => {
    cancelPendingOpen();
    setIsOpen(false);
  }, [cancelPendingOpen, serverId, routeWorkspaceId]);

  useKeyboardActionHandler({
    handlerId: "workspace-rename-global",
    actions: WORKSPACE_RENAME_ACTIONS,
    enabled: serverId !== null && fields !== null,
    priority: 0,
    handle,
  });

  const workspace = useMemo(
    () =>
      serverId && fields
        ? { serverId, workspaceId: fields.id, name: fields.name, title: fields.title }
        : null,
    [fields, serverId],
  );

  if (!workspace) return null;

  return (
    <WorkspaceRenameModal
      visible={isOpen}
      workspace={workspace}
      onClose={handleClose}
      testID="workspace-rename-modal-global"
    />
  );
}
