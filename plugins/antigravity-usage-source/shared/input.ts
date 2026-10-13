import { z } from "zod";

export const routeSchema = z
  .object({ store: z.literal("antigravity"), path: z.string().min(1) })
  .strict();

export const inputSchema = z.object({ route: routeSchema }).strict();
export type AntigravityUsageInput = z.infer<typeof inputSchema>;
