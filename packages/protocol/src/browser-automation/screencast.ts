import { z } from "zod";
import { BrowserAutomationBrowserIdSchema } from "./rpc-schemas.js";

/**
 * Viewers subscribe to a browser tab that lives on another host and receive
 * JPEG frames as binary `browser_screencast` frames keyed by the returned slot.
 *
 * `maxWidth` and `maxHeight` are the device pixels the viewer can display. One
 * capture is shared by every viewer of a browser, so the host runs at the
 * largest declared size; a viewer that declares nothing gets the daemon default.
 * They are a request, not a grant: the daemon clamps them to its own budget.
 *
 * `workspaceId` scopes the subscription the same way it scopes
 * `browser.tab.execute.request`. A viewer that declares one cannot reach a tab
 * the daemon knows belongs to another workspace.
 */
export const BrowserScreencastSubscribeRequestSchema = z.object({
  type: z.literal("browser.screencast.subscribe.request"),
  requestId: z.string(),
  browserId: BrowserAutomationBrowserIdSchema,
  workspaceId: z.string().min(1).optional(),
  maxWidth: z.number().int().positive().optional(),
  maxHeight: z.number().int().positive().optional(),
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

/**
 * One-way: dropping a viewer cannot fail and the viewer has nothing to wait for,
 * so there is no `requestId` and no matching `.response`.
 */
export const BrowserScreencastUnsubscribeRequestSchema = z.object({
  type: z.literal("browser.screencast.unsubscribe.request"),
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
