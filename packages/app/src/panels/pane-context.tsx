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

// Pane focus split (kept as a separate context for tests/components that consume only focus).
export interface PaneFocusContextValue {
  isWorkspaceFocused: boolean;
  isPaneFocused: boolean;
  isInteractive: boolean;
}

const PaneFocusContext = createContext<PaneFocusContextValue | null>(null);

export function createPaneFocusContextValue(input: {
  isWorkspaceFocused: boolean;
  isPaneFocused: boolean;
}): PaneFocusContextValue {
  return {
    isWorkspaceFocused: input.isWorkspaceFocused,
    isPaneFocused: input.isPaneFocused,
    isInteractive: input.isWorkspaceFocused && input.isPaneFocused,
  };
}

export function PaneFocusProvider({
  value,
  children,
}: {
  value: PaneFocusContextValue;
  children: ReactNode;
}) {
  return <PaneFocusContext.Provider value={value}>{children}</PaneFocusContext.Provider>;
}

export function usePaneFocus(): PaneFocusContextValue {
  const value = useContext(PaneFocusContext);
  invariant(value, "PaneFocusContext is required");
  return value;
}
