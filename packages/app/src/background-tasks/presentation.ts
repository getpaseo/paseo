import type { AgentBackgroundTaskPayload } from "@getpaseo/protocol/messages";

/** Claude Code's task type for a backgrounded Bash command. */
const SHELL_TASK_TYPE = "local_bash";

export type BackgroundTaskKind = "shell" | "monitor" | "other";

export function resolveBackgroundTaskKind(type: string): BackgroundTaskKind {
  if (type === SHELL_TASK_TYPE) {
    return "shell";
  }
  if (type.includes("monitor")) {
    return "monitor";
  }
  return "other";
}

/**
 * What the pill counts. Shells get their own noun because that is what the Claude Code footer
 * says ("1 shell"); a mix falls back to the generic noun so the count stays one number.
 */
export interface BackgroundTasksPillPresentation {
  noun: "shell" | "task";
  count: number;
}

export function buildBackgroundTasksPillPresentation(
  tasks: readonly AgentBackgroundTaskPayload[],
): BackgroundTasksPillPresentation {
  const allShells = tasks.every((task) => resolveBackgroundTaskKind(task.type) === "shell");
  return { noun: allShells ? "shell" : "task", count: tasks.length };
}
