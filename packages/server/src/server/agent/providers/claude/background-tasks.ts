import type { AgentBackgroundTask } from "../../agent-sdk-types.js";

/**
 * Task types the subagents track already owns. A backgrounded subagent keeps its workspace
 * running through its provider-subagent descriptor, and is stopped from that track.
 */
const SUBAGENT_TASK_TYPES = new Set(["local_agent", "local_workflow"]);

/**
 * Reads Claude Code's `system/background_tasks_changed` frame.
 *
 * Verified on the wire (Claude Code 2.1.296):
 *
 *   {"type":"system","subtype":"background_tasks_changed",
 *    "tasks":[{"task_id":"b1kxzuieg","task_type":"local_bash","description":"Sleep 6 seconds"}]}
 *
 * The frame carries the whole live set on every membership change, which is what the CLI footer
 * counts as "1 shell". Entries flagged `ambient` are Claude Code housekeeping, which the SDK marks
 * so hosts can leave it out of activity indicators.
 *
 * Replace the set from each frame instead of pairing `task_started` with a terminal status: a
 * foreground Bash call never announces itself, and a task that dies with its process never sends
 * a terminal status.
 *
 * Returns null for any other message.
 */
export function readClaudeBackgroundTasksChanged(message: unknown): AgentBackgroundTask[] | null {
  if (!isRecord(message) || message.type !== "system") {
    return null;
  }
  if (message.subtype !== "background_tasks_changed" || !Array.isArray(message.tasks)) {
    return null;
  }
  const tasks: AgentBackgroundTask[] = [];
  for (const entry of message.tasks) {
    if (!isRecord(entry) || entry.ambient === true) continue;
    const id = readNonEmptyString(entry.task_id);
    const type = readNonEmptyString(entry.task_type);
    if (!id || !type || SUBAGENT_TASK_TYPES.has(type)) continue;
    tasks.push({ id, type, description: readNonEmptyString(entry.description) ?? null });
  }
  return tasks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
