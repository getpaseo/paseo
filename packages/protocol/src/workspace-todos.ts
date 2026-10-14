import { z } from "zod";

export const WorkspaceTodoStatusSchema = z.enum(["todo", "in_progress", "done"]);
const TodoTextSchema = z.object({
  title: z.string().trim().min(1).max(1000),
  notes: z.string().max(100000),
  milestone: z.string().max(160).optional(),
});
export const WorkspaceTodoSchema = TodoTextSchema.extend({
  id: z.string().min(1),
  status: WorkspaceTodoStatusSchema,
  titleProtected: z.boolean(),
  notesProtected: z.boolean(),
  milestoneProtected: z.boolean().optional(),
});
export const WorkspaceTodosSchema = z.object({
  revision: z.number().int().nonnegative(),
  initialized: z.boolean(),
  tasks: z.array(WorkspaceTodoSchema).max(1000),
});
// Array position is the persisted task order.
export const WorkspaceTodoMutationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("initialize"), tasks: z.array(TodoTextSchema).max(1000) }),
  TodoTextSchema.extend({ operation: z.literal("add") }),
  z.object({
    operation: z.literal("update"),
    id: z.string(),
    title: TodoTextSchema.shape.title.optional(),
    notes: TodoTextSchema.shape.notes.optional(),
    milestone: TodoTextSchema.shape.milestone,
    status: WorkspaceTodoStatusSchema.optional(),
  }),
  z.object({ operation: z.literal("delete"), id: z.string() }),
  z.object({ operation: z.literal("reorder"), ids: z.array(z.string()).max(1000) }),
]);
export type WorkspaceTodo = z.infer<typeof WorkspaceTodoSchema>;
export type WorkspaceTodos = z.infer<typeof WorkspaceTodosSchema>;
export type WorkspaceTodoMutation = z.infer<typeof WorkspaceTodoMutationSchema>;
