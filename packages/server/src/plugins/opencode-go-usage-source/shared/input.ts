import { z } from "zod";

export const inputSchema = z.object({ apiKey: z.string().min(1) }).strict();
export type Input = z.infer<typeof inputSchema>;
