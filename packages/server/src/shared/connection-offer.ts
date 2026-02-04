import { z } from "zod";

export const ConnectionOfferV1Schema = z.object({
  v: z.literal(1),
  sessionId: z.string().min(1),
  endpoints: z.array(z.string().min(1)).min(1),
  daemonPublicKeyB64: z.string().min(1),
  relay: z
    .object({
      endpoint: z.string().min(1),
    })
    .nullable()
    .optional(),
});

export type ConnectionOfferV1 = z.infer<typeof ConnectionOfferV1Schema>;
