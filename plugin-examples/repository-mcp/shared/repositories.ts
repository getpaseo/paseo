import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const repositories = defineRpc({
  name: "repositories.list",
  input: z.object({ mode: z.enum(["normal", "empty", "failure"]).default("normal") }),
  output: z.object({
    repositories: z.array(z.object({ id: z.string(), path: z.string() })),
    error: z.string().nullable(),
  }),
});
