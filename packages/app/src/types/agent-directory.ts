import type { Agent } from "@/stores/session-store";

export type AgentDirectoryEntry = Pick<
  Agent,
  | "id"
  | "serverId"
  | "title"
  | "status"
  | "turn"
  | "lastActivityAt"
  | "cwd"
  | "workspaceId"
  | "provider"
  | "requiresAttention"
  | "attentionReason"
  | "attentionTimestamp"
  | "archivedAt"
  | "createdAt"
  | "labels"
  | "projectPlacement"
> & {
  pendingPermissionCount?: number;
  /** Conversation line that matched a history or Search query. */
  contentSnippet?: string | null;
};
