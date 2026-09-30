import { randomBytes } from "node:crypto";

import type { WorkspaceTopic } from "@getpaseo/protocol/messages";

import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "./workspace-registry.js";

export type WorkspaceTopicErrorCode =
  | "topic_title_required"
  | "topic_needs_workspaces"
  | "topic_not_found"
  | "workspace_not_found"
  | "workspace_archived";

type TopicRegistry = Pick<WorkspaceRegistry, "get" | "updateMany">;

export class WorkspaceTopicError extends Error {
  constructor(
    public readonly code: WorkspaceTopicErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceTopicError";
  }
}

export function generateTopicId(): string {
  return `top_${randomBytes(8).toString("hex")}`;
}

function normalizeTitle(title: string): string {
  const trimmed = title.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) {
    throw new WorkspaceTopicError("topic_title_required", "Topic title is required");
  }
  return trimmed;
}

function normalizeDescription(description: string | null | undefined): string | null {
  const trimmed = description?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

function requireActiveWorkspace(
  records: ReadonlyMap<string, PersistedWorkspaceRecord>,
  workspaceId: string,
): PersistedWorkspaceRecord {
  const workspace = records.get(workspaceId);
  if (!workspace) {
    throw new WorkspaceTopicError("workspace_not_found", `Workspace ${workspaceId} not found`);
  }
  if (workspace.archivedAt) {
    throw new WorkspaceTopicError("workspace_archived", `Workspace ${workspaceId} is archived`);
  }
  return workspace;
}

// A fresh record, not a mutation: the registry detects changes by reference.
function withTopic(
  record: PersistedWorkspaceRecord,
  topic: WorkspaceTopic,
  updatedAt: string,
): PersistedWorkspaceRecord {
  return { ...record, topic, updatedAt };
}

// Archived children count: restoring one brings it back into its topic.
function findTopic(
  records: ReadonlyMap<string, PersistedWorkspaceRecord>,
  topicId: string,
): WorkspaceTopic | null {
  for (const record of records.values()) {
    if (record.topic?.id === topicId) return record.topic;
  }
  return null;
}

export async function createWorkspaceTopic(
  registry: TopicRegistry,
  input: {
    title: string;
    description?: string | null;
    workspaceIds: readonly string[];
    now?: string;
    topicId?: string;
  },
): Promise<{ topic: WorkspaceTopic; workspaces: PersistedWorkspaceRecord[] }> {
  const topic: WorkspaceTopic = {
    id: input.topicId ?? generateTopicId(),
    title: normalizeTitle(input.title),
    description: normalizeDescription(input.description),
  };
  const workspaceIds = [...new Set(input.workspaceIds)];
  if (workspaceIds.length === 0) {
    throw new WorkspaceTopicError("topic_needs_workspaces", "A topic needs at least one workspace");
  }
  const updatedAt = input.now ?? new Date().toISOString();
  const workspaces = await registry.updateMany((records) =>
    workspaceIds.map((workspaceId) =>
      withTopic(requireActiveWorkspace(records, workspaceId), topic, updatedAt),
    ),
  );
  return { topic, workspaces };
}

/** Moves a workspace into an existing topic, or out of its topic when `topicId` is null. */
export async function assignWorkspaceTopic(
  registry: TopicRegistry,
  input: { workspaceId: string; topicId: string | null; now?: string },
): Promise<PersistedWorkspaceRecord> {
  const updatedAt = input.now ?? new Date().toISOString();
  const [workspace] = await registry.updateMany((records) => {
    const existing = requireActiveWorkspace(records, input.workspaceId);
    if (input.topicId === null) {
      if (!existing.topic) return [];
      const { topic: _detached, ...rest } = existing;
      return [{ ...rest, updatedAt }];
    }
    const topic = findTopic(records, input.topicId);
    if (!topic) {
      throw new WorkspaceTopicError("topic_not_found", `Topic ${input.topicId} not found`);
    }
    if (existing.topic?.id === topic.id) return [];
    return [withTopic(existing, topic, updatedAt)];
  });
  return workspace ?? requireRecord(await registry.get(input.workspaceId), input.workspaceId);
}

function requireRecord(
  record: PersistedWorkspaceRecord | null,
  workspaceId: string,
): PersistedWorkspaceRecord {
  if (!record) {
    throw new WorkspaceTopicError("workspace_not_found", `Workspace ${workspaceId} not found`);
  }
  return record;
}

export async function updateWorkspaceTopic(
  registry: TopicRegistry,
  input: { topicId: string; title?: string; description?: string | null; now?: string },
): Promise<{ topic: WorkspaceTopic; workspaces: PersistedWorkspaceRecord[] }> {
  const updatedAt = input.now ?? new Date().toISOString();
  const workspaces = await registry.updateMany((records) => {
    const current = findTopic(records, input.topicId);
    if (!current) {
      throw new WorkspaceTopicError("topic_not_found", `Topic ${input.topicId} not found`);
    }
    const topic: WorkspaceTopic = {
      id: current.id,
      title: input.title === undefined ? current.title : normalizeTitle(input.title),
      description:
        input.description === undefined
          ? current.description
          : normalizeDescription(input.description),
    };
    return [...records.values()]
      .filter((record) => record.topic?.id === topic.id)
      .map((record) => withTopic(record, topic, updatedAt));
  });
  // findTopic succeeded, so at least one child was rewritten.
  const topic = workspaces[0]?.topic;
  if (!topic) {
    throw new WorkspaceTopicError("topic_not_found", `Topic ${input.topicId} not found`);
  }
  return { topic, workspaces };
}
