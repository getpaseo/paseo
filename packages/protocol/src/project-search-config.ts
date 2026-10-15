import { z } from "zod";

export const ProjectSearchConfigSchema = z
  .object({
    searchRoots: z
      .array(
        z
          .string()
          .regex(/^(?:~(?:[\\/]|$)|[\\/]|[A-Za-z]:[\\/])/, "Use an absolute path or ~/ path"),
      )
      .min(1)
      .max(16)
      .optional(),
  })
  .passthrough();
