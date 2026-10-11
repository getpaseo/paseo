import { z } from "zod";

export const inputSchema = z.discriminatedUnion("store", [
  z
    .object({
      store: z.literal("environment"),
      variable: z.enum(["PASEO_SYNTHETIC_API_KEY", "SYNTHETIC_API_KEY"]),
    })
    .strict(),
  z
    .object({
      store: z.literal("opencode"),
      homeDir: z.string().min(1),
      xdgDataHome: z.string().min(1).optional(),
      databaseOverride: z.string().min(1).optional(),
    })
    .strict(),
]);

export type Input = z.infer<typeof inputSchema>;
