import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import type { OmpSessionState } from "./rpc-types.js";
import type { OmpToolResult } from "./tool-call-detail.js";
import {
  OmpTodoPhaseSchema,
  OmpTodoReminderEventSchema,
  type OmpTodoItem,
  type OmpTodoPhase,
} from "./rpc-types.js";

export function mapOmpTodoToolResult(result: OmpToolResult): AgentTimelineItem | null {
  const details = resultDetails(result);
  const phases = OmpTodoPhaseSchema.array().safeParse(details?.phases);
  return phases.success ? mapOmpTodoPhases(phases.data) : null;
}

export function mapOmpTodoReminderEvent(event: unknown): AgentTimelineItem | null {
  const parsed = OmpTodoReminderEventSchema.safeParse(event);
  return parsed.success ? mapOmpTodoItems(parsed.data.todos) : null;
}

export function mapOmpTodoState(state: OmpSessionState): AgentTimelineItem[] {
  const phases = OmpTodoPhaseSchema.array().safeParse(state.todoPhases);
  if (!phases.success) {
    return [];
  }
  const item = mapOmpTodoPhases(phases.data);
  return item ? [item] : [];
}

export function mapOmpTodoPhases(phases: readonly OmpTodoPhase[]): AgentTimelineItem | null {
  const todos = phases.flatMap((phase) => phase.tasks);
  return mapOmpTodoItems(todos);
}

function mapOmpTodoItems(items: readonly OmpTodoItem[]): AgentTimelineItem | null {
  if (items.length === 0) {
    return null;
  }
  return {
    type: "todo",
    items: items.map((item) => ({
      text: item.content,
      status: normalizeOmpTodoStatus(item.status),
      completed: item.status === "completed",
    })),
  };
}

function normalizeOmpTodoStatus(status: OmpTodoItem["status"]) {
  if (status === "completed") return "completed" as const;
  if (status === "in_progress") return "in_progress" as const;
  return "pending" as const;
}

function resultDetails(result: OmpToolResult): Record<string, unknown> | null {
  if (typeof result === "string" || result === null) {
    return null;
  }
  return isRecord(result.details) ? result.details : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
