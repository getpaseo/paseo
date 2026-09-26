import { z } from "zod";

export const inputSchema = z.union([
  z.object({ apiKey: z.string().min(1) }).strict(),
  z.object({}).strict(),
]);
export type Input = z.infer<typeof inputSchema>;
