import { z } from "zod";
import {
  BrowserAutomationCommandSchema,
  BrowserAutomationErrorSchema,
  BrowserAutomationResultSchema,
  BrowserAutomationTabInfoSchema,
} from "./rpc-schemas.js";

/**
 * Lets a client ask the daemon to run a browser command on whichever host owns
 * the tab. Viewers use it to list tabs that live on the daemon's machine, to
 * open new ones there, and to drive a tab they are mirroring.
 */
export const BrowserClientCommandRequestSchema = z.object({
  type: z.literal("browser.command.request"),
  requestId: z.string(),
  command: BrowserAutomationCommandSchema,
  workspaceId: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
});

export const BrowserClientCommandResponseSchema = z.object({
  type: z.literal("browser.command.response"),
  payload: z.union([
    z.object({
      requestId: z.string(),
      ok: z.literal(true),
      result: BrowserAutomationResultSchema,
    }),
    z.object({
      requestId: z.string(),
      ok: z.literal(false),
      error: BrowserAutomationErrorSchema,
    }),
  ]),
});

/**
 * A browser host tells the daemon that its tab set changed. Bare signal with no
 * response: the daemon re-runs its own `list_tabs` fan-out and broadcasts
 * `browsers_changed` with the result.
 */
export const BrowserTabsAnnounceRequestSchema = z.object({
  type: z.literal("browser.tabs.announce.request"),
});

/** The daemon's browser tab set after a host announced a change. */
export const BrowsersChangedSchema = z.object({
  type: z.literal("browsers_changed"),
  payload: z.object({
    tabs: z.array(BrowserAutomationTabInfoSchema),
  }),
});

export type BrowserClientCommandRequest = z.infer<typeof BrowserClientCommandRequestSchema>;
export type BrowserClientCommandResponse = z.infer<typeof BrowserClientCommandResponseSchema>;
export type BrowserTabsAnnounceRequest = z.infer<typeof BrowserTabsAnnounceRequestSchema>;
export type BrowsersChanged = z.infer<typeof BrowsersChangedSchema>;
