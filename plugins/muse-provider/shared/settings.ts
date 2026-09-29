import { z } from "zod";
import { defineSettings } from "@getpaseo/plugin";

export const settingsSchema = z.object({
  sandbox: z
    .boolean()
    .default(true)
    .describe("Keep Muse filesystem and network sandboxing enabled"),
  network: z
    .enum(["proxy-only", "restricted", "enabled"])
    .default("proxy-only")
    .describe("Sandbox network access; disabling sandbox forces full network access"),
  trustWorkspace: z
    .boolean()
    .default(false)
    .describe("Let Muse load project-scoped skills and config from the workspace"),
});

export const museSettings = defineSettings({
  id: "muse",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});
