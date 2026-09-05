import type { WorkspacePinGroup } from "@getpaseo/protocol/messages";
import {
  DEFAULT_WORKSPACE_PIN_GROUP_ID,
  type WorkspacePinGroupSelection,
} from "@/stores/sidebar-view-store";

export type WorkspacePinGroupMenuActionId = "create" | "rename" | "delete";

export interface WorkspacePinGroupChoice {
  group: WorkspacePinGroup;
  selected: boolean;
}

export interface WorkspacePinGroupMenuModel {
  activeGroup: WorkspacePinGroup | null;
  choices: WorkspacePinGroupChoice[];
  actions: WorkspacePinGroupMenuActionId[];
}

export type WorkspacePinAction =
  | { kind: "set-membership"; selection: WorkspacePinGroupSelection }
  | { kind: "update-host" }
  | { kind: "host-disconnected" }
  | { kind: "unavailable" };

export function reconcileWorkspacePinGroupSelection(input: {
  registeredServerIds: readonly string[];
  activePinGroup: WorkspacePinGroupSelection | null;
  activeWorkspaceServerId: string | null | undefined;
}): WorkspacePinGroupSelection | null {
  const activeWorkspaceServerId = input.activeWorkspaceServerId;
  if (
    !activeWorkspaceServerId ||
    !input.registeredServerIds.includes(activeWorkspaceServerId) ||
    input.activePinGroup?.serverId === activeWorkspaceServerId
  ) {
    return input.activePinGroup;
  }
  return {
    serverId: activeWorkspaceServerId,
    groupId: DEFAULT_WORKSPACE_PIN_GROUP_ID,
  };
}

export function resolveWorkspacePinGroupServerId(input: {
  registeredServerIds: readonly string[];
  activePinGroup: WorkspacePinGroupSelection | null;
  activeWorkspaceServerId: string | null | undefined;
  hostFilters: readonly string[];
}): string | null {
  const activePinGroup = input.activePinGroup;
  if (activePinGroup && input.registeredServerIds.includes(activePinGroup.serverId)) {
    return activePinGroup.serverId;
  }
  if (
    input.activeWorkspaceServerId &&
    input.registeredServerIds.includes(input.activeWorkspaceServerId)
  ) {
    return input.activeWorkspaceServerId;
  }
  const filteredServerId = input.hostFilters.length === 1 ? input.hostFilters[0] : null;
  if (filteredServerId && input.registeredServerIds.includes(filteredServerId)) {
    return filteredServerId;
  }
  if (input.registeredServerIds.length === 1) {
    return input.registeredServerIds[0] ?? null;
  }
  return [...input.registeredServerIds].sort().at(0) ?? null;
}

export function resolveWorkspacePinAction(input: {
  workspaceServerId: string | null | undefined;
  pinGroupAvailability: boolean | null;
  activePinGroup: WorkspacePinGroupSelection | null;
}): WorkspacePinAction {
  if (
    input.workspaceServerId == null ||
    input.workspaceServerId !== input.activePinGroup?.serverId
  ) {
    return { kind: "unavailable" };
  }
  if (input.pinGroupAvailability === null) {
    return { kind: "host-disconnected" };
  }
  if (!input.pinGroupAvailability) {
    return { kind: "update-host" };
  }
  return { kind: "set-membership", selection: input.activePinGroup };
}

export function buildWorkspacePinGroupMenuModel(input: {
  groups: readonly WorkspacePinGroup[];
  activeGroupId: string;
}): WorkspacePinGroupMenuModel {
  const activeGroup = input.groups.find((group) => group.id === input.activeGroupId) ?? null;
  const actions: WorkspacePinGroupMenuActionId[] = ["create"];
  if (activeGroup && activeGroup.id !== DEFAULT_WORKSPACE_PIN_GROUP_ID) {
    actions.push("rename", "delete");
  }
  return {
    activeGroup,
    choices: input.groups.map((group) => ({
      group,
      selected: group.id === input.activeGroupId,
    })),
    actions,
  };
}

export function isWorkspacePinnedInGroup(input: {
  pinGroupId: string | null | undefined;
  activeGroupId: string;
}): boolean {
  return input.pinGroupId === input.activeGroupId;
}

export interface WorkspacePinMutationPlan {
  groupId: string | null;
}

export function planWorkspacePinMutation(input: {
  pinGroupId: string | null | undefined;
  activeGroupId: string;
}): WorkspacePinMutationPlan {
  return {
    groupId: isWorkspacePinnedInGroup(input) ? null : input.activeGroupId,
  };
}
