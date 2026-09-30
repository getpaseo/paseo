import { z } from "zod";

export const inputSchema = z.object({}).strict();
export type Input = z.infer<typeof inputSchema>;
