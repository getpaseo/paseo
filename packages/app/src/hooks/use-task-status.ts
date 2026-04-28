// useTaskStatus — adapted from emdash's useTaskStatus + taskStatus.ts
// Derives busy/idle status for a task based on agent activity

import { useEffect, useState, useCallback } from "react";
import type { KanbanStatus } from "@/types/kanban";
import { useKanbanStore } from "@/stores/kanban-store";

export type DerivedTaskStatus = "idle" | "busy";

/**
 * Hook to track whether a specific task is currently busy (agent running).
 * In hubcode, this connects to the WebSocket agent activity stream.
 */
export function useTaskBusy(taskId: string): boolean {
  const [isBusy, setIsBusy] = useState(false);

  // TODO: Wire to actual WebSocket agent activity once session mapping is established
  // For now, returns false — tasks are manually moved between columns

  return isBusy;
}

/**
 * Hook to check if a task has unread messages/activity.
 */
export function useTaskUnread(taskId: string): boolean {
  const [isUnread, setIsUnread] = useState(false);

  // TODO: Wire to actual unread state from session store

  return isUnread;
}

/**
 * Hook to get git changes for a task path.
 */
export function useTaskChanges(taskPath?: string): {
  additions: number;
  deletions: number;
  files: number;
} | null {
  const [changes, setChanges] = useState<{
    additions: number;
    deletions: number;
    files: number;
  } | null>(null);

  // TODO: Wire to WebSocket git status queries

  return changes;
}

/**
 * Hook to get the agent names assigned to a task.
 */
export function useTaskAgentNames(taskId: string): string[] {
  // TODO: Wire to actual agent assignment from session store
  return [];
}

/**
 * Derive overall task status from multiple agent statuses.
 * Adapted from emdash's deriveTaskStatus.ts
 */
export type AgentStatusKind = "idle" | "working" | "waiting" | "error" | "complete" | "unknown";

export function deriveTaskStatus(statuses: AgentStatusKind[]): AgentStatusKind {
  if (statuses.includes("waiting")) return "waiting";
  if (statuses.includes("working")) return "working";
  if (statuses.includes("error")) return "error";
  if (statuses.includes("complete")) return "complete";
  if (statuses.includes("idle")) return "idle";
  return "unknown";
}
