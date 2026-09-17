import { z } from "zod";

const taskStatusSchema = z.enum(["pending", "in_progress", "completed"]);

export const piTaskListSchema = z.object({
  tasks: z.array(
    z.object({
      text: z.string(),
      status: taskStatusSchema,
    }),
  ),
});
