import React, { createContext, useContext, type ReactNode } from "react";
import invariant from "tiny-invariant";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";

export interface PaneContextValue {
  serverId: string;
  workspaceId: string;
  tabId: string;
  target: WorkspaceTabTarget;
  openTab(target: WorkspaceTabTarget): void;
  closeCurrentTab(): void;
  retargetCurrentTab(target: WorkspaceTabTarget): void;
  openFileInWorkspace(filePath: string): void;
}

export interface PaneFocusContextValue {
  isWorkspaceFocused: boolean;
  isPaneFocused: boolean;
  isInteractive: boolean;
}

const PaneContext = createContext<PaneContextValue | null>(null);
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

export function PaneProvider({
  value,
  children,
}: {
  value: PaneContextValue;
  children: ReactNode;
}) {
  return <PaneContext.Provider value={value}>{children}</PaneContext.Provider>;
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

export function usePaneContext(): PaneContextValue {
  const value = useContext(PaneContext);
  invariant(value, "PaneContext is required");
  return value;
}

export function usePaneFocus(): PaneFocusContextValue {
  const value = useContext(PaneFocusContext);
  invariant(value, "PaneFocusContext is required");
  return value;
}
