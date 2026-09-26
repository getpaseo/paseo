import { z } from "zod";
export const inputSchema = z.union([
  z.object({ configDir: z.string().min(1) }).strict(),
  z.object({ accessToken: z.string().min(1) }).strict(),
  z.object({}).strict(),
]);
export type UsageInput = z.infer<typeof inputSchema>;
