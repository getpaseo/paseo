import { z } from "zod";
export const inputSchema = z
  .object({
    store: z.enum(["env", "credentials", "config"]),
    locator: z.string().min(1),
  })
  .strict();
export type UsageInput = z.infer<typeof inputSchema>;
