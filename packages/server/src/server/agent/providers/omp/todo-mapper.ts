import { z } from "zod";

import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import type { OmpSessionState } from "./rpc-types.js";
import { XdevExecuteDetailsSchema, type OmpToolResult } from "./tool-call-detail.js";
import { OmpTodoPhaseSchema, type OmpTodoItem, type OmpTodoPhase } from "./rpc-types.js";

interface OmpTodoToolResultInput {
  toolName: string;
  result: OmpToolResult;
}

const TodoPhasesSchema = OmpTodoPhaseSchema.array();
const XdevTodoDetailsSchema = XdevExecuteDetailsSchema.extend({
  tool: z.literal("todo"),
  inner: z.object({ phases: TodoPhasesSchema }),
});

export function mapOmpTodoToolResult({
  toolName,
  result,
}: OmpTodoToolResultInput): AgentTimelineItem | null {
  if (result === null || typeof result === "string" || result.isError) return null;
  const details = resultDetails(result);
  if (toolName === "write") {
    const xdev = XdevTodoDetailsSchema.safeParse(details?.xdev);
    return xdev.success ? mapOmpTodoPhases(xdev.data.inner.phases) : null;
  }
  if (toolName !== "todo") return null;
  const phases = TodoPhasesSchema.safeParse(details?.phases);
  return phases.success ? mapOmpTodoPhases(phases.data) : null;
}

export function mapOmpTodoState(state: OmpSessionState): AgentTimelineItem[] {
  const phases = TodoPhasesSchema.safeParse(state.todoPhases);
  if (!phases.success) {
    return [];
  }
  return [mapOmpTodoPhases(phases.data)];
}

export function mapOmpTodoPhases(phases: readonly OmpTodoPhase[]): AgentTimelineItem {
  return {
    type: "todo",
    items: phases.flatMap((phase, phaseIndex) =>
      phase.tasks.map((item) => {
        const status = normalizeOmpTodoStatus(item.status);
        return {
          text: item.content,
          status,
          completed: status === "completed",
          state: item.status,
          phase: phase.name,
          phaseIndex,
          ...(item.blocker !== undefined ? { blocker: item.blocker } : {}),
        };
      }),
    ),
  };
}

// COMPAT(todoState): added after v0.7.2, remove after 2027-03-07 once supported
// clients read state. The legacy status enum cannot carry blocked or abandoned;
// abandoned must remain terminal for clients that only read completed/status.
function normalizeOmpTodoStatus(status: OmpTodoItem["status"]) {
  if (status === "completed" || status === "abandoned") return "completed" as const;
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
