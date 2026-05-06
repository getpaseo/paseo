import { navigateToWorkspace } from "@/hooks/use-workspace-navigation";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { generateDraftId } from "@/stores/draft-keys";
import {
  buildWorkspaceTabPersistenceKey,
  type WorkspaceTabTarget,
} from "@/stores/workspace-tabs-store";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";

interface PrepareWorkspaceTabInput {
  serverId: string;
  workspaceId: string;
  target: WorkspaceTabTarget;
  pin?: boolean;
}

interface NavigateToPreparedWorkspaceTabInput extends PrepareWorkspaceTabInput {
  currentPathname?: string | null;
}

function getPreparedTarget(target: WorkspaceTabTarget): WorkspaceTabTarget {
  if (target.kind !== "draft" || target.draftId.trim() !== "new") {
    return target;
  }
  return { kind: "draft", draftId: generateDraftId() };
}

export function prepareWorkspaceTab(input: PrepareWorkspaceTabInput) {
  const target = getPreparedTarget(input.target);
  const key =
    buildWorkspaceTabPersistenceKey({
      serverId: input.serverId,
      workspaceId: input.workspaceId,
    }) ?? "";

  useWorkspaceLayoutStore.getState().openTabFocused(key, target);

  if (input.pin && target.kind === "agent") {
    useWorkspaceLayoutStore.getState().pinAgent(key, target.agentId);
  }

  return buildHostWorkspaceRoute(input.serverId, input.workspaceId);
}

export function navigateToPreparedWorkspaceTab(input: NavigateToPreparedWorkspaceTabInput): string {
  const route = prepareWorkspaceTab(input);
  navigateToWorkspace(input.serverId, input.workspaceId, {
    currentPathname: input.currentPathname,
  });
  return route;
}
