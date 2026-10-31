import { z } from "zod";
export const inputSchema = z
  .object({
    store: z.enum(["env", "credentials", "config", "oauth"]),
    locator: z.string().min(1),
    /**
     * Base URL for the coding-plan quota endpoint. The CLI's OAuth login is
     * region-scoped (cn vs en), and each region serves its own host.
     */
    baseUrl: z.string().optional(),
  })
  .strict();
export type UsageInput = z.infer<typeof inputSchema>;
