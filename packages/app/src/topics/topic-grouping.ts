import {
  getWorkspaceStateBucketPriority,
  type WorkspaceStateBucket,
} from "@getpaseo/protocol/agent-state-bucket";
import type { WorkspaceTopic } from "@getpaseo/protocol/messages";

export interface TopicGroupableWorkspace {
  topic?: WorkspaceTopic | null;
  status: WorkspaceStateBucket;
}

export interface WorkspaceTopicGroup<T extends TopicGroupableWorkspace> {
  topic: WorkspaceTopic;
  children: T[];
  /** The most urgent child state, so a topic card never hides a child that needs you. */
  status: WorkspaceStateBucket;
  /** Sum over children that report a cost; null when none does. */
  costUsd: number | null;
}

export interface WorkspaceTopicGrouping<T extends TopicGroupableWorkspace> {
  /** In order of each topic's first child in `workspaces`. */
  topics: WorkspaceTopicGroup<T>[];
  ungrouped: T[];
}

export function groupWorkspacesByTopic<T extends TopicGroupableWorkspace>(
  workspaces: Iterable<T>,
  costUsdOf?: (workspace: T) => number | null,
): WorkspaceTopicGrouping<T> {
  const groups = new Map<string, WorkspaceTopicGroup<T>>();
  const ungrouped: T[] = [];
  for (const workspace of workspaces) {
    const topic = workspace.topic;
    if (!topic) {
      ungrouped.push(workspace);
      continue;
    }
    const cost = costUsdOf?.(workspace) ?? null;
    const group = groups.get(topic.id);
    if (!group) {
      groups.set(topic.id, {
        topic,
        children: [workspace],
        status: workspace.status,
        costUsd: cost,
      });
      continue;
    }
    group.children.push(workspace);
    if (
      getWorkspaceStateBucketPriority(workspace.status) <
      getWorkspaceStateBucketPriority(group.status)
    ) {
      group.status = workspace.status;
    }
    if (cost !== null) group.costUsd = (group.costUsd ?? 0) + cost;
  }
  return { topics: [...groups.values()], ungrouped };
}

/** Every topic with at least one visible child, for pickers that join an existing topic. */
export function listWorkspaceTopics(
  workspaces: Iterable<TopicGroupableWorkspace>,
): WorkspaceTopic[] {
  const topics = new Map<string, WorkspaceTopic>();
  for (const workspace of workspaces) {
    if (workspace.topic && !topics.has(workspace.topic.id)) {
      topics.set(workspace.topic.id, workspace.topic);
    }
  }
  return [...topics.values()];
}
