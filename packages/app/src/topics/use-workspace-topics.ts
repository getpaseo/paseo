import { useMemo } from "react";
import { useShallow } from "zustand/shallow";
import type { WorkspaceTopic } from "@getpaseo/protocol/messages";
import { i18n } from "@/i18n/i18next";
import { useHostFeature } from "@/runtime/host-features";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore, type Agent, type WorkspaceDescriptor } from "@/stores/session-store";
import {
  groupWorkspacesByTopic,
  listWorkspaceTopics,
  type WorkspaceTopicGroup,
} from "./topic-grouping";

export interface WorkspaceTopicsState {
  /** False when the host predates topics; show "update the host" instead of topic UI. */
  isSupported: boolean;
  groups: WorkspaceTopicGroup<WorkspaceDescriptor>[];
  ungrouped: WorkspaceDescriptor[];
  topics: WorkspaceTopic[];
}

const EMPTY_WORKSPACES: ReadonlyMap<string, WorkspaceDescriptor> = new Map();

// Agent cost is cumulative per agent session, so a workspace costs the sum of its agents.
// ponytail: rescans all agents per store change; index costs in the store if many surfaces use it.
function selectWorkspaceCosts(
  agents: ReadonlyMap<string, Agent> | undefined,
): Record<string, number> {
  const costs: Record<string, number> = {};
  if (!agents) return costs;
  for (const agent of agents.values()) {
    const cost = agent.lastUsage?.totalCostUsd;
    if (!agent.workspaceId || typeof cost !== "number") continue;
    costs[agent.workspaceId] = (costs[agent.workspaceId] ?? 0) + cost;
  }
  return costs;
}

export function useWorkspaceTopics(serverId: string | null | undefined): WorkspaceTopicsState {
  const isSupported = useHostFeature(serverId, "workspaceTopics");
  const workspaces = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.workspaces : undefined,
  );
  const costs = useSessionStore(
    useShallow((state) =>
      selectWorkspaceCosts(serverId ? state.sessions[serverId]?.agents : undefined),
    ),
  );
  return useMemo(() => {
    const list = [...(workspaces ?? EMPTY_WORKSPACES).values()];
    const { topics: groups, ungrouped } = groupWorkspacesByTopic(
      list,
      (workspace) => costs[workspace.id] ?? null,
    );
    return { isSupported, groups, ungrouped, topics: listWorkspaceTopics(list) };
  }, [isSupported, workspaces, costs]);
}

export interface WorkspaceTopicActions {
  createTopic(input: { title: string; workspaceIds: string[] }): Promise<WorkspaceTopic>;
  /** Null takes the workspace out of its topic; the last one out dissolves the topic. */
  assignTopic(workspaceId: string, topicId: string | null): Promise<void>;
  renameTopic(topicId: string, title: string): Promise<WorkspaceTopic>;
}

function requireClient(serverId: string) {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) throw new Error(i18n.t("topics.errors.hostDisconnected"));
  return client;
}

// Results reach the store through the workspace updates the daemon broadcasts, so these only
// send the request and surface its error.
export function createWorkspaceTopicActions(serverId: string): WorkspaceTopicActions {
  return {
    createTopic: (input) => requireClient(serverId).createWorkspaceTopic(input),
    assignTopic: async (workspaceId, topicId) => {
      await requireClient(serverId).assignWorkspaceTopic(workspaceId, topicId);
    },
    renameTopic: (topicId, title) =>
      requireClient(serverId).updateWorkspaceTopic(topicId, { title }),
  };
}

export function useWorkspaceTopicActions(serverId: string): WorkspaceTopicActions {
  return useMemo(() => createWorkspaceTopicActions(serverId), [serverId]);
}
