import { z } from "zod";
/** `credentials` is OpenCode 2's own login listing with auth.json behind it; `file` is auth.json only. */
export const inputSchema = z.object({ store: z.enum(["file", "credentials"]) }).strict();
export type Input = z.infer<typeof inputSchema>;
