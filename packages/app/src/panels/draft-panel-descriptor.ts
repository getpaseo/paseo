import type { ComponentType } from "react";
import type { PanelDescriptor, PanelIconProps } from "@/panels/panel-registry";

interface DraftPanelDescriptorLabels {
  newAgent: string;
  creatingAgent: string;
}

const DEFAULT_DRAFT_PANEL_DESCRIPTOR_LABELS: DraftPanelDescriptorLabels = {
  newAgent: "New Agent",
  creatingAgent: "Creating agent",
};

export function buildDraftPanelDescriptor(input: {
  isCreating: boolean;
  pendingPrompt?: string | null;
  icon: ComponentType<PanelIconProps>;
  labels?: DraftPanelDescriptorLabels;
}): PanelDescriptor {
  const { icon, isCreating, pendingPrompt } = input;
  const labels = input.labels ?? DEFAULT_DRAFT_PANEL_DESCRIPTOR_LABELS;
  const creatingLabel = pendingPrompt?.trim() || labels.newAgent;
  if (isCreating) {
    return {
      label: creatingLabel,
      subtitle: labels.creatingAgent,
      titleState: "ready",
      icon,
      statusBucket: "running",
    };
  }

  return {
    label: labels.newAgent,
    subtitle: labels.newAgent,
    titleState: "ready",
    icon,
    statusBucket: null,
  };
}
