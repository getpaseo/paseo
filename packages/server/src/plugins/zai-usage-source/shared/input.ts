import { z } from "zod";
export const inputSchema = z.object({}).strict();

export type UsageInput = z.infer<typeof inputSchema>;
