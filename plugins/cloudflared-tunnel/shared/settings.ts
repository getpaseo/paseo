import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const cloudflaredSettings = defineSettings({
  id: "cloudflared",
  scope: "host",
  version: 1,
  schema: z.object({
    binaryPath: z.string().trim().min(1).optional(),
  }),
});

export type CloudflaredSettings = z.infer<typeof cloudflaredSettings.schema>;
