import { z } from "zod";

/** Activity owned by a plugin, with the same ordering semantics as native workspace state. */
export const WorkspaceActivityInputSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
  workspaceId: z.string().min(1),
  kind: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
  label: z.string().min(1).max(256).regex(/\S/),
  status: z.enum(["running", "attention", "needs_input", "failed"]),
  /** A Lucide icon name. The client supplies a generic activity icon for unknown names. */
  icon: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z][A-Za-z0-9]*$/)
    .optional(),
  count: z.number().int().positive().max(1_000_000).optional(),
  /** Complete group membership. Item IDs are stable and scoped to this activity. */
  items: z
    .array(
      z.object({
        id: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
        label: z.string().min(1).max(256).regex(/\S/),
      }),
    )
    .min(1)
    .max(512)
    .optional(),
});

export const WorkspaceActivitySchema = WorkspaceActivityInputSchema.extend({
  /** Host-generated identity: plugin id and plugin-local activity id. */
  id: z.string().min(1),
  pluginId: z.string().min(1),
  activityId: z.string().min(1),
  /** Host time of the last actual change; identical updates preserve it. */
  changedAt: z.string(),
});

export type WorkspaceActivityInput = z.infer<typeof WorkspaceActivityInputSchema>;
export type WorkspaceActivity = z.infer<typeof WorkspaceActivitySchema>;

/** Keep wire schemas structural; registration enforces identity and count consistency. */
export function parseWorkspaceActivityInput(value: unknown): WorkspaceActivityInput {
  const input = WorkspaceActivityInputSchema.parse(value);
  if (input.items) {
    if (new Set(input.items.map((item) => item.id)).size !== input.items.length) {
      throw new Error("Workspace activity has duplicate item ids");
    }
    if (input.count !== undefined && input.count !== input.items.length) {
      throw new Error("Workspace activity count must equal its item count");
    }
    return { ...input, count: input.items.length };
  }
  return input;
}
