import { router } from "expo-router";
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

  const tabId = useWorkspaceLayoutStore.getState().openTabFocused(key, target);

  if (tabId) {
    useWorkspaceLayoutStore.getState().focusTab(key, tabId);
  }

  if (input.pin && target.kind === "agent") {
    useWorkspaceLayoutStore.getState().pinAgent(key, target.agentId);
  }

  return buildHostWorkspaceRoute(input.serverId, input.workspaceId);
}

interface NavigateToPreparedWorkspaceTabInput extends PrepareWorkspaceTabInput {
  /** "push" pushes a new history entry; "replace" overwrites current. Default "push". */
  navigationMethod?: "push" | "replace";
}

export function navigateToPreparedWorkspaceTab(input: NavigateToPreparedWorkspaceTabInput): string {
  const route = prepareWorkspaceTab(input);
  if (input.navigationMethod === "replace") {
    router.replace(route as never);
  } else {
    router.push(route as never);
  }
  return route;
}
