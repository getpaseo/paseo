import { z } from "zod";
export const inputSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("signin"), keyPath: z.string().min(1) }).strict(),
  z.object({ source: z.literal("env"), locator: z.string().min(1) }).strict(),
]);
export type UsageInput = z.infer<typeof inputSchema>;
