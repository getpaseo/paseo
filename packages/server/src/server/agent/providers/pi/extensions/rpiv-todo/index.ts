import { z } from "zod";
import type { AgentTaskItem } from "../../../../agent-sdk-types.js";
import type { PiExtension } from "../contract.js";

const Details = z.object({
  action: z.enum(["create", "update", "list", "get", "delete", "clear"]),
  params: z.record(z.string(), z.unknown()),
  nextId: z.number().int(),
  tasks: z.array(
    z.object({
      id: z.number().int(),
      subject: z.string(),
      status: z.enum(["pending", "in_progress", "completed", "deleted"]),
      activeForm: z.string().optional(),
    }),
  ),
  error: z.string().optional(),
});

export const rpivTodo: PiExtension = {
  id: "rpiv-todo",
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
                items: parsed.data.tasks.flatMap((task): AgentTaskItem[] => {
                  if (task.status === "deleted") return [];
                  const item: AgentTaskItem = {
                    id: String(task.id),
                    text: task.subject,
                    status: task.status,
                    completed: task.status === "completed",
                  };
                  if (task.activeForm) item.activeForm = task.activeForm;
                  return [item];
                }),
              },
            ],
      };
    },
  }),
};
