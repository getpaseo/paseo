import React, { useEffect, useMemo, type ComponentType } from "react";
import invariant from "tiny-invariant";
import {
  createPaneFocusContextValue,
  PaneFocusProvider,
  PaneProvider,
  type PaneContextValue,
} from "@/panels/pane-context";
import { getPanelRegistration } from "@/panels/panel-registry";
import { ensurePanelsRegistered } from "@/panels/register-panels";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import {
  clearActivePaneFindPaneId,
  createPaneFindPaneId,
  setActivePaneFindPaneId,
} from "@/panels/pane-find-registry";

export interface WorkspacePaneContentModel {
  key: string;
  Component: ComponentType;
  paneContextValue: PaneContextValue;
}

export interface BuildWorkspacePaneContentModelInput {
  tab: WorkspaceTabDescriptor;
  paneId?: string | null;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  onOpenTab: (target: WorkspaceTabDescriptor["target"]) => void;
  onCloseCurrentTab: () => void;
  onRetargetCurrentTab: (target: WorkspaceTabDescriptor["target"]) => void;
  onOpenWorkspaceFile: (filePath: string) => void;
}

export function buildWorkspacePaneContentModel({
  tab,
  paneId,
  normalizedServerId,
  normalizedWorkspaceId,
  onOpenTab,
  onCloseCurrentTab,
  onRetargetCurrentTab,
  onOpenWorkspaceFile,
}: BuildWorkspacePaneContentModelInput): WorkspacePaneContentModel {
  ensurePanelsRegistered();
  const registration = getPanelRegistration(tab.kind);
  invariant(registration, `No panel registration for kind: ${tab.kind}`);
  const paneInstanceId = paneId
    ? createPaneFindPaneId({
        serverId: normalizedServerId,
        workspaceId: normalizedWorkspaceId,
        paneId,
      })
    : null;
  return {
    key: `${normalizedServerId}:${normalizedWorkspaceId}:${tab.tabId}:${tab.kind}`,
    Component: registration.component,
    paneContextValue: {
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
      paneInstanceId,
      tabId: tab.tabId,
      target: tab.target,
      openTab: onOpenTab,
      closeCurrentTab: onCloseCurrentTab,
      retargetCurrentTab: onRetargetCurrentTab,
      openFileInWorkspace: onOpenWorkspaceFile,
    },
  };
}

export interface WorkspacePaneContentProps {
  content: WorkspacePaneContentModel;
  isWorkspaceFocused: boolean;
  isPaneFocused: boolean;
  onFocusPane?: () => void;
}

export function WorkspacePaneContent({
  content,
  isWorkspaceFocused,
  isPaneFocused,
  onFocusPane,
}: WorkspacePaneContentProps) {
  const { Component, key, paneContextValue } = content;
  const paneFocusValue = useMemo(
    () =>
      createPaneFocusContextValue({
        isWorkspaceFocused,
        isPaneFocused,
        onFocusPane,
      }),
    [isPaneFocused, isWorkspaceFocused, onFocusPane],
  );
  useEffect(() => {
    if (!paneContextValue.paneInstanceId || !isWorkspaceFocused || !isPaneFocused) {
      return;
    }
    const paneInstanceId = paneContextValue.paneInstanceId;
    setActivePaneFindPaneId(paneInstanceId);
    return () => {
      clearActivePaneFindPaneId(paneInstanceId);
    };
  }, [isPaneFocused, isWorkspaceFocused, paneContextValue.paneInstanceId]);

  return (
    <PaneProvider value={paneContextValue}>
      <PaneFocusProvider value={paneFocusValue}>
        <Component key={key} />
      </PaneFocusProvider>
    </PaneProvider>
  );
}
