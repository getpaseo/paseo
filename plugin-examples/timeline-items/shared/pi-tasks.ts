import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin";
import { z } from "zod";

const taskStatusSchema = z.enum(["pending", "in_progress", "completed"]);

const rpivDetailsSchema = z.object({
  tasks: z.array(
    z
      .object({
        subject: z.string(),
        status: z.enum(["pending", "in_progress", "completed", "deleted"]),
      })
      .passthrough(),
  ),
});

const piExampleDetailsSchema = z.object({
  todos: z.array(
    z
      .object({
        id: z.number().int().optional(),
        text: z.string(),
        done: z.boolean(),
      })
      .passthrough(),
  ),
});

export const piTaskListSchema = z.object({
  tasks: z.array(
    z.object({
      text: z.string(),
      status: taskStatusSchema,
    }),
  ),
});

type PiTask = z.output<typeof piTaskListSchema>["tasks"][number];
type ToolCallTransformer = PluginTimelineTransformerContribution<"tool_call">["transform"];

function replacement(tasks: PiTask[]) {
  if (tasks.length === 0) return;
  return {
    items: [
      {
        type: "plugin" as const,
        kind: "pi-task-list",
        version: 1,
        data: { tasks },
      },
    ],
  };
}

export const transformPiTodoToolCall: ToolCallTransformer = ({ item }) => {
  if (item.name !== "todo" || item.detail.type !== "unknown") {
    return;
  }

  const result = item.detail.output;
  if (!result || typeof result !== "object" || Array.isArray(result)) return;
  const details = Reflect.get(result, "details");

  const rpiv = rpivDetailsSchema.safeParse(details);
  if (rpiv.success) {
    return replacement(
      rpiv.data.tasks.flatMap((task): PiTask[] =>
        task.status === "deleted" ? [] : [{ text: task.subject, status: task.status }],
      ),
    );
  }

  const piExample = piExampleDetailsSchema.safeParse(details);
  if (piExample.success) {
    return replacement(
      piExample.data.todos.map((todo) => ({
        text: todo.text,
        status: todo.done ? "completed" : "pending",
      })),
    );
  }
};
