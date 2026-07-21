import type { OpenTabPlacementOptions } from "@/stores/workspace-layout-store";
import { generateDraftId } from "@/stores/draft-keys";
import {
  buildWorkspaceTabPersistenceKey,
  type WorkspaceTabTarget,
} from "@/stores/workspace-tabs-store";

export interface PrepareWorkspaceTabInput {
  serverId: string;
  workspaceId: string;
  target: WorkspaceTabTarget;
  pin?: boolean;
  /** Open the tab directly to the right of this tab instead of at the end. */
  insertAfterTabId?: string;
}

export interface PrepareWorkspaceTabDeps {
  openTabFocused: (
    workspaceKey: string,
    target: WorkspaceTabTarget,
    options?: OpenTabPlacementOptions,
  ) => string | null;
  pinAgent: (workspaceKey: string, agentId: string) => void;
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

  deps.openTabFocused(
    key,
    target,
    input.insertAfterTabId ? { insertAfterTabId: input.insertAfterTabId } : undefined,
  );

  if (input.pin && target.kind === "agent") {
    deps.pinAgent(key, target.agentId);
  }
}
