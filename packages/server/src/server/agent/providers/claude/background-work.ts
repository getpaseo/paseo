import type { AgentBackgroundWorkInput } from "../../background-work/index.js";
import { CLAUDE_SUBAGENT_TASK_TYPE, CLAUDE_WORKFLOW_TASK_TYPE } from "./subagents/live-source.js";

export interface ClaudeBackgroundTask {
  task_id: string;
  task_type: string;
  /** The user's `claude` binary can differ from the SDK typings, so this is read defensively. */
  description?: unknown;
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
      canStop: task.task_type === "local_bash",
      description: readDescription(task.description),
    }));
}

/** The inventory owner refines shell entries when launch metadata identifies a monitor. */
function toKind(taskType: string): string {
  if (taskType === "local_bash") return "shell";
  return "other";
}

function readDescription(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
