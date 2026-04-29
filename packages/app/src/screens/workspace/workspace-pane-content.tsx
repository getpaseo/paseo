import type { ComponentType } from "react";
import invariant from "tiny-invariant";
import { PaneProvider, type PaneContextValue } from "@/panels/pane-context";
import { getPanelRegistration } from "@/panels/panel-registry";
import { ensurePanelsRegistered } from "@/panels/register-panels";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

export interface WorkspacePaneContentModel {
  key: string;
  Component: ComponentType;
  paneContextValue: PaneContextValue;
}

export interface BuildWorkspacePaneContentModelInput {
  tab: WorkspaceTabDescriptor;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  // Optional in the input shape — when omitted (e.g. tests, or paseo-style
  // callers that pass focus separately to <WorkspacePaneContent />), the model
  // defaults to false and lets the wrapper component override it via props.
  isPaneFocused?: boolean;
  onOpenTab: (target: WorkspaceTabDescriptor["target"]) => void;
  onCloseCurrentTab: () => void;
  onRetargetCurrentTab: (target: WorkspaceTabDescriptor["target"]) => void;
  onOpenWorkspaceFile: (filePath: string) => void;
}

export function buildWorkspacePaneContentModel({
  tab,
  normalizedServerId,
  normalizedWorkspaceId,
  isPaneFocused,
  onOpenTab,
  onCloseCurrentTab,
  onRetargetCurrentTab,
  onOpenWorkspaceFile,
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
      isPaneFocused: isPaneFocused ?? false,
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
  // Accepted for paseo-compat tests/callers that thread focus state down to
  // the wrapper rather than baking it into the model. The wrapper currently
  // forwards them via the model's pane context — these are type-only stubs.
  isPaneFocused?: boolean;
  isWorkspaceFocused?: boolean;
}

export function WorkspacePaneContent({ content }: WorkspacePaneContentProps) {
  const { Component, key, paneContextValue } = content;

  return (
    <PaneProvider value={paneContextValue}>
      <Component key={key} />
    </PaneProvider>
  );
}
