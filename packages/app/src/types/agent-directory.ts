import type { AgentHistoryContentSource, AgentHistoryMatchBand } from "@getpaseo/protocol/messages";
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
  /** Where that line was taken from. The label is not part of the snippet. */
  contentSource?: AgentHistoryContentSource | null;
  /** message outranks trace. Absent on an unscored row. */
  contentMatchBand?: AgentHistoryMatchBand | null;
};
