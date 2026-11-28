import { z } from "zod";

export const ACPProviderOptionsSchema = z
  .object({
    // Composer control: approves permission prompts without asking.
    auto_accept: z.boolean().optional(),
    supportsMcpServers: z.boolean().optional(),
    clientCapabilities: z
      .object({
        fs: z
          .object({
            readTextFile: z.boolean().optional(),
            writeTextFile: z.boolean().optional(),
          })
          .optional(),
        terminal: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough();
