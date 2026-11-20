import { z } from "zod";

export const routeSchema = z.discriminatedUnion("store", [
  z.object({ store: z.enum(["codex", "opencode", "pi"]), path: z.string().min(1) }).strict(),
  z
    .object({
      store: z.literal("omp"),
      path: z.string().min(1),
      credentialId: z.number().int().positive(),
    })
    .strict(),
]);
export const inputSchema = z.object({ route: routeSchema }).strict();
export type CodexUsageInput = z.infer<typeof inputSchema>;
