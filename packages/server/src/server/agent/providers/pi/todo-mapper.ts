import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import type { PiToolResult } from "./tool-call-mapper.js";

interface PiTodoTask {
  id: number;
  subject: string;
  status: string;
  activeForm?: string;
  blockedBy?: number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTodoTask(value: unknown): value is PiTodoTask {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    typeof value.subject === "string" &&
    typeof value.status === "string"
  );
}

function readTodoTasks(details: unknown): PiTodoTask[] {
  if (!isRecord(details) || !Array.isArray(details.tasks)) {
    return [];
  }
  return details.tasks.filter(isTodoTask);
}

/**
 * Whether a Pi rpiv-todo tool result carries a renderable task snapshot.
 *
 * rpiv-todo stores the full task list in `details.tasks` on every operation.
 * A result is renderable only when `details` is a record and `details.tasks`
 * is an array. An empty array is a valid state that clears the previous
 * TodoListCard. A non-empty array must contain at least one valid task —
 * if every entry is malformed the snapshot is broken, and rendering it as
 * an authoritative empty list would erase previously shown tasks. Callers
 * fall back to an unknown tool-call card for such results.
 */
export function canMapPiTodoToolResult(result: PiToolResult): boolean {
  const details = typeof result === "object" && result !== null ? result.details : undefined;
  if (!isRecord(details) || !Array.isArray(details.tasks)) {
    return false;
  }
  return details.tasks.length === 0 || details.tasks.some(isTodoTask);
}

/**
 * Parse a Pi rpiv-todo tool result and produce a todo timeline item
 * for Paseo's TodoListCard component.
 *
 * rpiv-todo stores the full task list in `details.tasks` on every
 * operation. We extract subject→text, status→completed and filter
 * out deleted tasks.
 */
export function mapPiTodoToolResult(result: PiToolResult): AgentTimelineItem | null {
  const details = typeof result === "object" && result !== null ? result.details : undefined;
  if (!canMapPiTodoToolResult(result)) {
    // Malformed result: nothing we can render. Stay silent — the caller
    // (tool-call-mapper) falls back to an unknown tool-call card so the
    // operation and its output are not lost.
    return null;
  }
  const tasks = readTodoTasks(details);
  // Filter deleted (tombstoned) tasks. An empty list is still a valid state
  // — it clears the previous TodoListCard (clear/delete-final-task).
  const visibleTasks = tasks.filter((t) => t.status !== "deleted");
  return {
    type: "todo",
    items: visibleTasks.map((task) => ({
      text: task.subject,
      completed: task.status === "completed",
    })),
  };
}
