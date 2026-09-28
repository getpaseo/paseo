import { z } from "zod";

export const inputSchema = z.union([
  z.object({ codexHome: z.string().min(1) }).strict(),
  z.object({ accessToken: z.string().min(1), accountId: z.string().optional() }).strict(),
  z.object({}).strict(),
]);
export type CodexUsageInput = z.infer<typeof inputSchema>;
