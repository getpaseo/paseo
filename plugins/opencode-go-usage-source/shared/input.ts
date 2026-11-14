import { z } from "zod";

export const inputSchema = z.discriminatedUnion("store", [
  z.object({ store: z.literal("api-key"), path: z.string().min(1) }).strict(),
  z.object({ store: z.literal("console"), path: z.string().min(1) }).strict(),
]);
export type Input = z.infer<typeof inputSchema>;
