import type { Agent } from "@/stores/session-store";

export type AgentDirectoryEntry = Pick<
  Agent,
  | "id"
  | "serverId"
  | "title"
  | "status"
  | "lastActivityAt"
  | "cwd"
  | "provider"
  | "requiresAttention"
  | "attentionReason"
  | "attentionTimestamp"
  | "archivedAt"
  | "createdAt"
  | "labels"
> & {
  pendingPermissionCount?: number;
  /**
   * Agent's `cwd` is not registered as a workspace in the active org.
   * Surfaces a "Global" tag in the UI so users understand the agent isn't
   * org-scoped (e.g., it was started in a directory before any org claimed
   * it, or after an org switch). Still rendered in lists; not hidden.
   */
  isGlobal?: boolean;
};
