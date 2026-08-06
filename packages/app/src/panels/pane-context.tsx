import React, { createContext, useContext, type ReactNode } from "react";
import invariant from "tiny-invariant";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";

export interface PaneContextValue {
  serverId: string;
  workspaceId: string;
  tabId: string;
  target: WorkspaceTabTarget;
  /**
   * Optional working directory override for panels that resolve their cwd
   * from the workspace (e.g. the terminal panel). Used by surfaces that render
   * panels before a workspace exists (the New Workspace screen). When unset,
   * panels fall back to the workspace directory as before.
   */
  cwdOverride?: string;
  fileNavigationRevision?: number;
  openTab: (target: WorkspaceTabTarget) => void;
  closeCurrentTab: () => void;
  retargetCurrentTab: (target: WorkspaceTabTarget) => void;
  openFileInWorkspace: (request: WorkspaceFileOpenRequest) => void;
  openImportSheet: () => void;
}

export interface PaneFocusContextValue {
  isWorkspaceFocused: boolean;
  isPaneFocused: boolean;
  isInteractive: boolean;
  focusPane: () => void;
}

const PaneContext = createContext<PaneContextValue | null>(null);
const PaneFocusContext = createContext<PaneFocusContextValue | null>(null);
const noopFocusPane = () => {};

export function createPaneFocusContextValue(input: {
  isWorkspaceFocused: boolean;
  isPaneFocused: boolean;
  onFocusPane?: () => void;
}): PaneFocusContextValue {
  return {
    isWorkspaceFocused: input.isWorkspaceFocused,
    isPaneFocused: input.isPaneFocused,
    isInteractive: input.isWorkspaceFocused && input.isPaneFocused,
    focusPane: input.onFocusPane ?? noopFocusPane,
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
