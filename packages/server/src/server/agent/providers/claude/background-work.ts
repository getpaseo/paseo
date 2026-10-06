import type { AgentBackgroundWorkInput } from "../../background-work/store.js";
import { CLAUDE_SUBAGENT_TASK_TYPE, CLAUDE_WORKFLOW_TASK_TYPE } from "./subagents/live-source.js";

export interface ClaudeBackgroundTask {
  task_id: string;
  task_type: string;
  description: string;
}

/** Subagents and workflows already live in the subagents track. */
const SUBAGENT_TASK_TYPES = new Set([CLAUDE_SUBAGENT_TASK_TYPE, CLAUDE_WORKFLOW_TASK_TYPE]);

/** Maps `background_tasks_changed.tasks` to provider-agnostic background work. */
export function toBackgroundWorkInputs(
  tasks: readonly ClaudeBackgroundTask[],
): AgentBackgroundWorkInput[] {
  return tasks
    .filter((task) => !SUBAGENT_TASK_TYPES.has(task.task_type))
    .map((task) => ({
      id: task.task_id,
      kind: toKind(task.task_type),
      description: task.description.trim() || null,
    }));
}

function toKind(taskType: string): string {
  if (taskType === "local_bash") return "shell";
  if (/monitor/i.test(taskType)) return "monitor";
  return "other";
}
