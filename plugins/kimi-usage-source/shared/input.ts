import { z } from "zod";
export const inputSchema = z
  .object({
    store: z.enum(["env", "file"]),
    locator: z.string().min(1),
    baseUrl: z.url().optional(),
  })
  .strict();
export type UsageInput = z.infer<typeof inputSchema>;
