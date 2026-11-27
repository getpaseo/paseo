import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const cloudflaredSettings = defineSettings({
  id: "cloudflared",
  scope: "host",
  version: 1,
  schema: z.object({
    binaryPath: z.string().trim().min(1).optional(),
    /** Cloudflare named tunnel token (passed via TUNNEL_TOKEN). Runs the remotely configured tunnel. */
    tunnelToken: z.string().trim().min(1).optional(),
    /** Public base URL routed to the named tunnel in Cloudflare Zero Trust. */
    publicBaseUrl: z.string().trim().min(1).optional(),
  }),
});

export type CloudflaredSettings = z.infer<typeof cloudflaredSettings.schema>;
