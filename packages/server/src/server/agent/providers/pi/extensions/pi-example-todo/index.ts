import { z } from "zod";
import type { PiExtension } from "../contract.js";

const Details = z.object({
  action: z.enum(["list", "add", "toggle", "clear"]),
  nextId: z.number().int(),
  todos: z.array(z.object({ id: z.number().int(), text: z.string(), done: z.boolean() })),
  error: z.string().optional(),
});

export const piExampleTodo: PiExtension = {
  id: "pi-example-todo",
  createSession: () => ({
    mapToolCall(call) {
      if (
        call.toolName !== "todo" ||
        call.status !== "completed" ||
        !call.result ||
        typeof call.result === "string"
      )
        return undefined;
      const parsed = Details.safeParse(call.result.details);
      if (!parsed.success) return undefined;
      return {
        timeline: parsed.data.error
          ? []
          : [
              {
                type: "todo",
                items: parsed.data.todos.map((todo) => ({
                  id: String(todo.id),
                  text: todo.text,
                  status: todo.done ? "completed" : "pending",
                  completed: todo.done,
                })),
              },
            ],
      };
    },
  }),
};
