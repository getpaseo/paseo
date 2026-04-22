import { router } from "expo-router";
import { isNative } from "@/constants/platform";
import {
  activateNavigationWorkspaceSelection,
  getLastNavigationWorkspaceRouteSelection,
  overrideNextNavigationWorkspaceRouteSelection,
} from "@/stores/navigation-active-workspace-store";
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
  navigationMethod?: "navigate" | "replace";
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
  if (input.navigationMethod === "replace") {
    const canReturnToWorkspaceShell =
      isNative && getLastNavigationWorkspaceRouteSelection() !== null && router.canGoBack();
    if (canReturnToWorkspaceShell) {
      const nextSelection = {
        serverId: input.serverId,
        workspaceId: input.workspaceId,
      };
      overrideNextNavigationWorkspaceRouteSelection(nextSelection);
      router.back();
      setTimeout(() => {
        activateNavigationWorkspaceSelection(nextSelection);
      }, 0);
      return route;
    }
    router.replace(route as any);
  } else {
    router.navigate(route as any);
  }
  return route;
}
