import { z } from "zod";
import { BrowserAutomationBrowserIdSchema } from "./rpc-schemas.js";

/**
 * Viewers subscribe to a browser tab that lives on another host and receive
 * JPEG frames as binary `browser_screencast` frames keyed by the returned slot.
 */
export const BrowserScreencastSubscribeRequestSchema = z.object({
  type: z.literal("browser.screencast.subscribe.request"),
  requestId: z.string(),
  browserId: BrowserAutomationBrowserIdSchema,
});

export const BrowserScreencastSubscribeResponseSchema = z.object({
  type: z.literal("browser.screencast.subscribe.response"),
  payload: z.union([
    z.object({
      requestId: z.string(),
      browserId: BrowserAutomationBrowserIdSchema,
      slot: z.number().int().min(0).max(255),
      error: z.null(),
    }),
    z.object({
      requestId: z.string(),
      browserId: BrowserAutomationBrowserIdSchema,
      error: z.string(),
    }),
  ]),
});

export const BrowserScreencastUnsubscribeRequestSchema = z.object({
  type: z.literal("browser.screencast.unsubscribe.request"),
  requestId: z.string(),
  browserId: BrowserAutomationBrowserIdSchema,
});

export type BrowserScreencastSubscribeRequest = z.infer<
  typeof BrowserScreencastSubscribeRequestSchema
>;
export type BrowserScreencastSubscribeResponse = z.infer<
  typeof BrowserScreencastSubscribeResponseSchema
>;
export type BrowserScreencastUnsubscribeRequest = z.infer<
  typeof BrowserScreencastUnsubscribeRequestSchema
>;
