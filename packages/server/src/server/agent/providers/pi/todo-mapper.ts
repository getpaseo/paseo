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
 * Parse a Pi rpiv-todo tool result and produce a todo timeline item
 * for Paseo's TodoListCard component.
 *
 * rpiv-todo stores the full task list in `details.tasks` on every
 * operation. We extract subject→text, status→completed and filter
 * out deleted tasks.
 */
export function mapPiTodoToolResult(result: PiToolResult): AgentTimelineItem | null {
  const details = typeof result === "object" && result !== null ? result.details : undefined;
  const tasks = readTodoTasks(details);
  if (!isRecord(details) || !Array.isArray(details.tasks)) {
    // Malformed result: nothing we can render. Stay silent.
    return null;
  }
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
