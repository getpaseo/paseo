import { z } from "zod";
export const inputSchema = z
  .object({ store: z.enum(["file", "database"]), path: z.string().min(1) })
  .strict();
export type Input = z.infer<typeof inputSchema>;
