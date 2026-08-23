import { z } from "zod";

import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import type { PiAgentMessage } from "./rpc-types.js";
import type { PiToolResult } from "./tool-call-mapper.js";

// Pi core has no todo state: todos come from the `todo` extension tool, which
// returns details {todos: [{id, text, done}], nextId} (see pi's
// examples/extensions/todo.ts).
export const PiTodoExtensionItemSchema = z
  .object({
    id: z.number().int().optional(),
    text: z.string(),
    done: z.boolean(),
  })
  .passthrough();
export const PiTodoDetailsSchema = z
  .object({ todos: z.array(PiTodoExtensionItemSchema) })
  .passthrough();

export type PiTodoExtensionItem = z.infer<typeof PiTodoExtensionItemSchema>;

export function mapPiTodoToolResult(result: PiToolResult): AgentTimelineItem | null {
  const details = resultDetails(result);
  const todos = PiTodoDetailsSchema.safeParse(details);
  return todos.success ? mapPiTodoItems(todos.data.todos) : null;
}

export function mapPiTodoMessages(messages: readonly PiAgentMessage[]): AgentTimelineItem | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "toolResult" || message.toolName !== "todo") {
      continue;
    }
    const todos = PiTodoDetailsSchema.safeParse(message.details);
    if (todos.success) {
      return mapPiTodoItems(todos.data.todos);
    }
  }
  return null;
}

export function mapPiTodoItems(items: readonly PiTodoExtensionItem[]): AgentTimelineItem | null {
  if (items.length === 0) {
    return null;
  }
  return {
    type: "todo",
    items: items.map((item) => ({
      text: item.text,
      status: item.done ? ("completed" as const) : ("pending" as const),
      completed: item.done,
    })),
  };
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
