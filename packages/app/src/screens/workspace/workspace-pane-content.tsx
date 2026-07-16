import React, { useEffect, useMemo, type ComponentType } from "react";
import invariant from "tiny-invariant";
import {
  createPaneFindPaneId,
  createPaneFocusContextValue,
  PaneFocusProvider,
  PaneProvider,
  type PaneContextValue,
} from "@/panels/pane-context";
import { paneFindController } from "@/pane-find/pane-find-controller";
import { useStableEvent } from "@/hooks/use-stable-event";
import { getPanelRegistration } from "@/panels/panel-registry";
import { ensurePanelsRegistered } from "@/panels/register-panels";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { RenderProfile } from "@/utils/render-profiler";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";

export interface WorkspacePaneContentModel {
  key: string;
  Component: ComponentType;
  paneContextValue: PaneContextValue;
}

export interface BuildWorkspacePaneContentModelInput {
  tab: WorkspaceTabDescriptor;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  onOpenTab: (target: WorkspaceTabDescriptor["target"]) => void;
  onCloseCurrentTab: () => void;
  onRetargetCurrentTab: (target: WorkspaceTabDescriptor["target"]) => void;
  onOpenWorkspaceFile: (request: WorkspaceFileOpenRequest) => void;
  onOpenImportSheet: () => void;
}

export function buildWorkspacePaneContentModel({
  tab,
  normalizedServerId,
  normalizedWorkspaceId,
  onOpenTab,
  onCloseCurrentTab,
  onRetargetCurrentTab,
  onOpenWorkspaceFile,
  onOpenImportSheet,
}: BuildWorkspacePaneContentModelInput): WorkspacePaneContentModel {
  ensurePanelsRegistered();
  const registration = getPanelRegistration(tab.kind);
  invariant(registration, `No panel registration for kind: ${tab.kind}`);
  return {
    key: `${normalizedServerId}:${normalizedWorkspaceId}:${tab.tabId}`,
    Component: registration.component,
    paneContextValue: {
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
      tabId: tab.tabId,
      paneInstanceId: createPaneFindPaneId({
        serverId: normalizedServerId,
        workspaceId: normalizedWorkspaceId,
        tabId: tab.tabId,
      }),
      target: tab.target,
      openTab: onOpenTab,
      closeCurrentTab: onCloseCurrentTab,
      retargetCurrentTab: onRetargetCurrentTab,
      openFileInWorkspace: onOpenWorkspaceFile,
      openImportSheet: onOpenImportSheet,
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
  const openTab = useStableEvent(paneContextValue.openTab);
  const closeCurrentTab = useStableEvent(paneContextValue.closeCurrentTab);
  const retargetCurrentTab = useStableEvent(paneContextValue.retargetCurrentTab);
  const openFileInWorkspace = useStableEvent(paneContextValue.openFileInWorkspace);
  const openImportSheet = useStableEvent(paneContextValue.openImportSheet);
  const stablePaneContextValue = useMemo(
    () => ({
      serverId: paneContextValue.serverId,
      workspaceId: paneContextValue.workspaceId,
      tabId: paneContextValue.tabId,
      paneInstanceId: paneContextValue.paneInstanceId,
      target: paneContextValue.target,
      openTab,
      closeCurrentTab,
      retargetCurrentTab,
      openFileInWorkspace,
      openImportSheet,
    }),
    [
      closeCurrentTab,
      openFileInWorkspace,
      openImportSheet,
      openTab,
      paneContextValue.serverId,
      paneContextValue.tabId,
      paneContextValue.paneInstanceId,
      paneContextValue.target,
      paneContextValue.workspaceId,
      retargetCurrentTab,
    ],
  );

  // Central find-focus authority: exactly the focused pane (workspace focused
  // AND this pane focused) owns Ctrl/Cmd+F. Every pane renders through this
  // wrapper, so routing lives here in one place with one uniform condition —
  // instead of each pane component registering its own (previously
  // inconsistent) focus signal into a last-writer-wins registry.
  const paneInstanceId = paneContextValue.paneInstanceId;
  useEffect(() => {
    if (!isWorkspaceFocused || !isPaneFocused) {
      return;
    }
    paneFindController.setFocusedPane(paneInstanceId);
    return () => {
      paneFindController.clearFocusedPaneIfCurrent(paneInstanceId);
    };
  }, [isPaneFocused, isWorkspaceFocused, paneInstanceId]);
  const paneFocusValue = useMemo(
    () =>
      createPaneFocusContextValue({
        isWorkspaceFocused,
        isPaneFocused,
        onFocusPane,
      }),
    [isPaneFocused, isWorkspaceFocused, onFocusPane],
  );

  return (
    <RenderProfile
      id={`WorkspacePaneContent:${paneContextValue.target.kind}:${paneContextValue.tabId}`}
    >
      <PaneProvider value={stablePaneContextValue}>
        <PaneFocusProvider value={paneFocusValue}>
          <Component key={key} />
        </PaneFocusProvider>
      </PaneProvider>
    </RenderProfile>
  );
}
