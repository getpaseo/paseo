import { z } from "zod";
import { BrowserAutomationTabInfoSchema } from "./rpc-schemas.js";

/**
 * Lists browser tabs across every registered host, so a client can see and open
 * tabs that live on the daemon's machine rather than its own.
 */
export const BrowserTabsListRequestSchema = z.object({
  type: z.literal("browser.tabs.list.request"),
  requestId: z.string(),
  workspaceId: z.string().min(1).optional(),
});

export const BrowserTabsListResponseSchema = z.object({
  type: z.literal("browser.tabs.list.response"),
  payload: z.union([
    z.object({
      requestId: z.string(),
      tabs: z.array(BrowserAutomationTabInfoSchema),
      error: z.null(),
    }),
    z.object({
      requestId: z.string(),
      error: z.string(),
    }),
  ]),
});

export type BrowserTabsListRequest = z.infer<typeof BrowserTabsListRequestSchema>;
export type BrowserTabsListResponse = z.infer<typeof BrowserTabsListResponseSchema>;
