import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import invariant from "tiny-invariant";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";

export interface PaneContextValue {
  serverId: string;
  workspaceId: string;
  tabId: string;
  isPaneFocused: boolean;
  target: WorkspaceTabTarget;
  openTab(target: WorkspaceTabTarget): void;
  closeCurrentTab(): void;
  retargetCurrentTab(target: WorkspaceTabTarget): void;
  openFileInWorkspace(filePath: string): void;
}

const PaneContext = createContext<PaneContextValue | null>(null);

/**
 * Stabilizes the context value so that only changes to identity fields
 * (serverId, workspaceId, tabId, isPaneFocused, target) cause consumers
 * to re-render.  Callback changes are absorbed via refs.
 */
export function PaneProvider({
  value,
  children,
}: {
  value: PaneContextValue;
  children: ReactNode;
}) {
  const openTabRef = useRef(value.openTab);
  openTabRef.current = value.openTab;
  const closeCurrentTabRef = useRef(value.closeCurrentTab);
  closeCurrentTabRef.current = value.closeCurrentTab;
  const retargetCurrentTabRef = useRef(value.retargetCurrentTab);
  retargetCurrentTabRef.current = value.retargetCurrentTab;
  const openFileInWorkspaceRef = useRef(value.openFileInWorkspace);
  openFileInWorkspaceRef.current = value.openFileInWorkspace;

  const stableValue = useMemo<PaneContextValue>(
    () => ({
      serverId: value.serverId,
      workspaceId: value.workspaceId,
      tabId: value.tabId,
      isPaneFocused: value.isPaneFocused,
      target: value.target,
      openTab: (target) => openTabRef.current(target),
      closeCurrentTab: () => closeCurrentTabRef.current(),
      retargetCurrentTab: (target) => retargetCurrentTabRef.current(target),
      openFileInWorkspace: (filePath) => openFileInWorkspaceRef.current(filePath),
    }),
    // Only re-create when identity fields change
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value.serverId, value.workspaceId, value.tabId, value.isPaneFocused, value.target],
  );

  return <PaneContext.Provider value={stableValue}>{children}</PaneContext.Provider>;
}

export function usePaneContext(): PaneContextValue {
  const value = useContext(PaneContext);
  invariant(value, "PaneContext is required");
  return value;
}
