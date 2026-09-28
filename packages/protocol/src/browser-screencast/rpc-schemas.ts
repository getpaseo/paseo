import { z } from "zod";

// The viewer's trade between motion, sharpness and bytes; daemons that predate it stream "smooth".
export const BrowserScreencastQualitySchema = z.enum(["smooth", "sharp", "saver"]);
export type BrowserScreencastQuality = z.infer<typeof BrowserScreencastQualitySchema>;

// Frames arrive as binary frames on the response slot; the viewer acks them there.
export const BrowserScreencastSubscribeRequestSchema = z.object({
  type: z.literal("browser.screencast.subscribe.request"),
  requestId: z.string(),
  workspaceId: z.string().min(1),
  browserId: z.string().min(1),
  quality: BrowserScreencastQualitySchema.optional(),
});

export const BrowserScreencastSubscribeResponseSchema = z.object({
  type: z.literal("browser.screencast.subscribe.response"),
  payload: z.union([
    z.object({
      requestId: z.string(),
      browserId: z.string(),
      subscriptionId: z.string(),
      slot: z.number().int().min(0).max(255),
      error: z.null(),
    }),
    z.object({
      requestId: z.string(),
      browserId: z.string(),
      error: z.string(),
    }),
  ]),
});

// The tab closed; the daemon has already released the subscription.
export const BrowserScreencastEndedSchema = z.object({
  type: z.literal("browser.screencast.ended"),
  payload: z.object({
    subscriptionId: z.string().optional(),
    browserId: z.string(),
  }),
});
