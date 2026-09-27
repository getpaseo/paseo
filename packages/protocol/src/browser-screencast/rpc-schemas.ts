import { z } from "zod";

// Frames arrive as binary frames on the response slot; the viewer acks them there.
export const BrowserScreencastSubscribeRequestSchema = z.object({
  type: z.literal("browser.screencast.subscribe.request"),
  requestId: z.string(),
  workspaceId: z.string().min(1),
  browserId: z.string().min(1),
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
