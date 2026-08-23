import { z } from "zod";

import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import type { PiAgentMessage } from "./rpc-types.js";
import type { PiToolResult } from "./tool-call-mapper.js";

// Supported shapes for `todo` tool results:
// - @juicesharp/rpiv-todo: details {tasks: [{id, subject, status, ...}], nextId}
// - pi's examples/extensions/todo.ts: details {todos: [{id, text, done}], nextId}
const RpivTodoItemSchema = z
  .object({
    subject: z.string(),
    status: z.enum(["pending", "in_progress", "completed", "deleted"]),
  })
  .passthrough();
const RpivTodoDetailsSchema = z.object({ tasks: z.array(RpivTodoItemSchema) }).passthrough();

const DemoTodoItemSchema = z
  .object({ id: z.number().int().optional(), text: z.string(), done: z.boolean() })
  .passthrough();
const DemoTodoDetailsSchema = z.object({ todos: z.array(DemoTodoItemSchema) }).passthrough();

interface PiTodoSnapshot {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export function mapPiTodoToolResult(result: PiToolResult): AgentTimelineItem | null {
  const details = resultDetails(result);
  return mapPiTodoDetails(details);
}

export function mapPiTodoMessages(messages: readonly PiAgentMessage[]): AgentTimelineItem | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "toolResult" || message.toolName !== "todo") {
      continue;
    }
    const item = mapPiTodoDetails(isRecord(message.details) ? message.details : null);
    if (item) {
      return item;
    }
  }
  return null;
}

function mapPiTodoDetails(details: Record<string, unknown> | null): AgentTimelineItem | null {
  if (!details) {
    return null;
  }
  const rpiv = RpivTodoDetailsSchema.safeParse(details);
  if (rpiv.success) {
    return mapPiTodoSnapshots(
      rpiv.data.tasks.flatMap((task): PiTodoSnapshot[] =>
        task.status === "deleted" ? [] : [{ text: task.subject, status: task.status }],
      ),
    );
  }
  const demo = DemoTodoDetailsSchema.safeParse(details);
  if (demo.success) {
    return mapPiTodoSnapshots(
      demo.data.todos.map((todo) => ({
        text: todo.text,
        status: todo.done ? "completed" : "pending",
      })),
    );
  }
  return null;
}

function mapPiTodoSnapshots(items: readonly PiTodoSnapshot[]): AgentTimelineItem | null {
  if (items.length === 0) {
    return null;
  }
  return {
    type: "todo",
    items: items.map((item) => ({
      text: item.text,
      status: item.status,
      completed: item.status === "completed",
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
