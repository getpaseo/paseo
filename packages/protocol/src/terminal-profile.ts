import { z } from "zod";

export const TerminalProfileSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    command: z.string(),
    args: z.array(z.string()).optional(),
    icon: z.string().optional(),
  })
  .passthrough();

export type TerminalProfile = z.infer<typeof TerminalProfileSchema>;
