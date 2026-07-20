import React, { createContext, useContext, type ReactNode } from "react";
import invariant from "tiny-invariant";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";

export interface PaneContextValue {
  serverId: string;
  workspaceId: string;
  tabId: string;
  /**
   * Stable identity for this pane slot, `serverId:workspaceId:tabId`. Used as
   * the single key for find ownership: `WorkspacePaneContent` marks this pane
   * as the find-focused pane centrally, and the pane's own content registers
   * its find adapter under the same key (see pane-find-controller). This
   * replaces the old per-pane, content-derived focus keys so exactly one pane
   * — the focused one — owns Ctrl/Cmd+F.
   */
  paneInstanceId: string;
  target: WorkspaceTabTarget;
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

/** Builds the stable pane-find key for a pane slot. */
export function createPaneFindPaneId(input: {
  serverId: string;
  workspaceId: string;
  tabId: string;
}): string {
  return `${input.serverId}:${input.workspaceId}:${input.tabId}`;
}

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

/**
 * The pane slot's find key (`paneInstanceId`), or null when rendered outside a
 * PaneProvider (e.g. marketing mockups). Non-throwing so panes can register
 * their find adapter under the central key when available and simply skip find
 * otherwise.
 */
export function usePaneFindKey(): string | null {
  return useContext(PaneContext)?.paneInstanceId ?? null;
}
