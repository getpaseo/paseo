import { z } from "zod";
export const inputSchema = z
  .object({
    store: z.literal("env"),
    locator: z.string().min(1),
  })
  .strict();
export type UsageInput = z.infer<typeof inputSchema>;
