// getAgentForTask — adapted from emdash's getAgentForTask.ts

import type { KanbanTask } from "@/types/kanban";
import type { TaskMetadata } from "@/types/integrations";

export function getAgentForTask(task: KanbanTask, metadata?: TaskMetadata | null): string | null {
  if (metadata?.multiAgent?.enabled) {
    return null; // multi-agent, no single agent
  }
  return task.agentProvider || task.agentId || "claude-code";
}
