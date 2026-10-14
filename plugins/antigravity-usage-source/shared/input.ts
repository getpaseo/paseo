import { z } from "zod";

export const routeSchema = z.discriminatedUnion("store", [
  z.object({ store: z.literal("antigravity"), path: z.string().min(1) }).strict(),
  z
    .object({
      store: z.literal("keychain"),
      service: z.string().optional(),
      account: z.string().optional(),
    })
    .strict(),
]);

export const inputSchema = z.object({ route: routeSchema }).strict();
export type AntigravityUsageInput = z.infer<typeof inputSchema>;
