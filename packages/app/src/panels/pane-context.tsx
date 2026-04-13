import { createContext, useContext, type ReactNode } from "react";
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

export function PaneProvider({
  value,
  children,
}: {
  value: PaneContextValue;
  children: ReactNode;
}) {
  return <PaneContext.Provider value={value}>{children}</PaneContext.Provider>;
}

export function usePaneContext(): PaneContextValue {
  const value = useContext(PaneContext);
  invariant(value, "PaneContext is required");
  return value;
}
