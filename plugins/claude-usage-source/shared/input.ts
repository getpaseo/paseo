import { z } from "zod";

export const routeSchema = z.discriminatedUnion("store", [
  z.object({ store: z.enum(["claude", "pi"]), path: z.string().min(1) }).strict(),
  z
    .object({
      store: z.literal("omp"),
      path: z.string().min(1),
      credentialId: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      store: z.literal("keychain"),
      service: z.string().optional(),
      account: z.string().optional(),
    })
    .strict(),
]);
export const inputSchema = z.object({ route: routeSchema }).strict();
export type UsageInput = z.infer<typeof inputSchema>;
