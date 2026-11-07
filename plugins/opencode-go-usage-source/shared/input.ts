import { z } from "zod";
export const inputSchema = z.object({ path: z.string().min(1) }).strict();
export type Input = z.infer<typeof inputSchema>;
