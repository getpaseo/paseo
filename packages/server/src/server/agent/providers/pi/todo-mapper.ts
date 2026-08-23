import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import type { PiSessionState } from "./rpc-types.js";
import type { PiToolResult } from "./tool-call-mapper.js";
import {
  PiTodoPhaseSchema,
  PiTodoReminderEventSchema,
  type PiTodoItem,
  type PiTodoPhase,
} from "./rpc-types.js";

export function mapPiTodoToolResult(result: PiToolResult): AgentTimelineItem | null {
  const details = resultDetails(result);
  const phases = PiTodoPhaseSchema.array().safeParse(details?.phases);
  return phases.success ? mapPiTodoPhases(phases.data) : null;
}

export function mapPiTodoReminderEvent(event: unknown): AgentTimelineItem | null {
  const parsed = PiTodoReminderEventSchema.safeParse(event);
  return parsed.success ? mapPiTodoItems(parsed.data.todos) : null;
}

export function mapPiTodoState(state: PiSessionState): AgentTimelineItem[] {
  const phases = PiTodoPhaseSchema.array().safeParse(state.todoPhases);
  if (!phases.success) {
    return [];
  }
  const item = mapPiTodoPhases(phases.data);
  return item ? [item] : [];
}

export function mapPiTodoPhases(phases: readonly PiTodoPhase[]): AgentTimelineItem | null {
  const todos = phases.flatMap((phase) => phase.tasks);
  return mapPiTodoItems(todos);
}

function mapPiTodoItems(items: readonly PiTodoItem[]): AgentTimelineItem | null {
  if (items.length === 0) {
    return null;
  }
  return {
    type: "todo",
    items: items.map((item) => ({
      text: item.content,
      status: normalizePiTodoStatus(item.status),
      completed: item.status === "completed",
    })),
  };
}

function normalizePiTodoStatus(status: PiTodoItem["status"]) {
  if (status === "completed") return "completed" as const;
  if (status === "in_progress") return "in_progress" as const;
  return "pending" as const;
}

function resultDetails(result: PiToolResult): Record<string, unknown> | null {
  if (typeof result === "string" || result === null) {
    return null;
  }
  return isRecord(result.details) ? result.details : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
