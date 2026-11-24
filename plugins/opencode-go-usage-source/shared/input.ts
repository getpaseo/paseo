import { z } from "zod";
/** `credentials` is OpenCode 2's own login listing; `file` is OpenCode 1's auth.json. */
export const inputSchema = z.object({ store: z.enum(["file", "credentials"]) }).strict();
export type Input = z.infer<typeof inputSchema>;
