import { generateDraftId } from "@/stores/draft-keys";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { WorkspaceTabPlacement } from "@/stores/workspace-layout-actions";

export interface PrepareWorkspaceTabInput {
  serverId: string;
  workspaceId: string;
  target: WorkspaceTabTarget;
  pin?: boolean;
  placement?: WorkspaceTabPlacement;
}

export interface PrepareWorkspaceTabDeps {
  openTab: (input: {
    workspaceKey: string;
    target: WorkspaceTabTarget;
    intent: "reveal";
    pin?: boolean;
    placement?: WorkspaceTabPlacement;
  }) => string | null;
}

function getPreparedTarget(target: WorkspaceTabTarget): WorkspaceTabTarget {
  if (target.kind !== "draft" || target.draftId.trim() !== "new") {
    return target;
  }
  return { kind: "draft", draftId: generateDraftId() };
}

export function prepareWorkspaceTab(
  input: PrepareWorkspaceTabInput,
  deps: PrepareWorkspaceTabDeps,
): void {
  const target = getPreparedTarget(input.target);
  const key =
    buildWorkspaceTabPersistenceKey({
      serverId: input.serverId,
      workspaceId: input.workspaceId,
    }) ?? "";

  deps.openTab({
    workspaceKey: key,
    target,
    intent: "reveal",
    pin: input.pin === true && target.kind === "agent",
    placement: input.placement,
  });
}
