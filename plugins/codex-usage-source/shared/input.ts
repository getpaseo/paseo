import { z } from "zod";

export const inputSchema = z.object({}).strict();
export type CodexUsageInput = z.infer<typeof inputSchema>;
