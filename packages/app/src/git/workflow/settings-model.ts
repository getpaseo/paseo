import type { WorkspaceGitWorkflowConfig } from "@getpaseo/protocol/messages";
import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";

export type WorkspaceWorkflowModel = NonNullable<WorkspaceGitWorkflowConfig["reviewModel"]>;
export type WorkspaceWorkflowModelKey = "reviewModel" | "commitModel" | "prModel";

export interface WorkspaceGitWorkflowSettingsModel {
  reviewProfileId: string;
  deliveryProfileId: string;
  reviewPrompt: string;
  createPrPrompt: string;
  commitAndPushPrompt: string;
  reviewModel: WorkspaceWorkflowModel | null;
  commitModel: WorkspaceWorkflowModel | null;
  prModel: WorkspaceWorkflowModel | null;
}

export function createWorkspaceGitWorkflowSettingsModel(
  config: WorkspaceGitWorkflowConfig | undefined,
): WorkspaceGitWorkflowSettingsModel {
  return {
    reviewProfileId: config?.reviewProfileId ?? "",
    deliveryProfileId: config?.deliveryProfileId ?? "",
    reviewPrompt: config?.reviewPrompt ?? "",
    createPrPrompt: config?.createPrPrompt ?? "",
    commitAndPushPrompt: config?.commitAndPushPrompt ?? "",
    reviewModel: config?.reviewModel ?? null,
    commitModel: config?.commitModel ?? null,
    prModel: config?.prModel ?? null,
  };
}

export function workspaceGitWorkflowSettingsPatch(
  model: WorkspaceGitWorkflowSettingsModel,
): WorkspaceGitWorkflowConfig {
  return {
    reviewProfileId: model.reviewProfileId,
    deliveryProfileId: model.deliveryProfileId,
    reviewPrompt: model.reviewPrompt,
    createPrPrompt: model.createPrPrompt,
    commitAndPushPrompt: model.commitAndPushPrompt,
    reviewModel: model.reviewModel,
    commitModel: model.commitModel,
    prModel: model.prModel,
  };
}

export function selectWorkspaceWorkflowModel(
  previous: WorkspaceWorkflowModel | null,
  provider: string,
  modelId: string,
  definition: AgentModelDefinition | null,
): WorkspaceWorkflowModel {
  const thinkingOptionId =
    previous?.provider === provider &&
    definition?.thinkingOptions?.some((option) => option.id === previous.thinkingOptionId)
      ? previous.thinkingOptionId
      : undefined;
  return {
    provider,
    ...(modelId ? { model: modelId } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
  };
}
