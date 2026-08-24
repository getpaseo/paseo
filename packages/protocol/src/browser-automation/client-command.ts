import { z } from "zod";
import {
  BrowserAutomationBackCommandSchema,
  BrowserAutomationCloseTabCommandSchema,
  BrowserAutomationErrorSchema,
  BrowserAutomationForwardCommandSchema,
  BrowserAutomationInputAtCommandSchema,
  BrowserAutomationListTabsCommandSchema,
  BrowserAutomationNavigateCommandSchema,
  BrowserAutomationNewTabCommandSchema,
  BrowserAutomationReloadCommandSchema,
  BrowserAutomationResizeCommandSchema,
  BrowserAutomationResultSchema,
  BrowserAutomationTabInfoSchema,
} from "./rpc-schemas.js";

/**
 * What a viewer may ask the daemon to run: the operations the mirror UI exposes,
 * plus the list and open calls that put a tab on screen.
 *
 * Deliberately narrower than `BrowserAutomationCommandSchema`, which is the
 * daemon-to-host contract. `screencast_start` and `screencast_stop` are absent
 * because the daemon owns screencast slot allocation and issues them itself;
 * `evaluate`, `upload` and the ref-based commands are absent because they are
 * agent tooling with no mirrored UI behind them.
 */
export const BrowserViewerCommandSchema = z.discriminatedUnion("command", [
  BrowserAutomationListTabsCommandSchema,
  BrowserAutomationNewTabCommandSchema,
  BrowserAutomationNavigateCommandSchema,
  BrowserAutomationBackCommandSchema,
  BrowserAutomationForwardCommandSchema,
  BrowserAutomationReloadCommandSchema,
  BrowserAutomationResizeCommandSchema,
  BrowserAutomationCloseTabCommandSchema,
  BrowserAutomationInputAtCommandSchema,
]);

/**
 * Lets a client ask the daemon to run a viewer command on whichever host owns
 * the tab. Viewers use it to list tabs that live on the daemon's machine, to
 * open new ones there, and to drive a tab they are mirroring.
 */
export const BrowserTabExecuteRequestSchema = z.object({
  type: z.literal("browser.tab.execute.request"),
  requestId: z.string(),
  command: BrowserViewerCommandSchema,
  workspaceId: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
});

export const BrowserTabExecuteResponseSchema = z.object({
  type: z.literal("browser.tab.execute.response"),
  // Plain union despite the shared `ok` tag: zod-aot compiles a boolean
  // discriminator into a string comparison, so the generated client validator
  // rejects every branch. `packages/protocol/tests/validation/ws-outbound.test.ts`
  // holds the regression. Switch to `z.discriminatedUnion("ok", ...)` when that
  // test starts passing.
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
 * A browser host tells the daemon that its tab set changed. One-way: it carries
 * no `requestId` and has no response. The daemon answers by re-running its own
 * `list_tabs` fan-out and pushing `browser.tabs.changed` with the result.
 */
export const BrowserTabsAnnounceRequestSchema = z.object({
  type: z.literal("browser.tabs.announce.request"),
});

/** The daemon's browser tab set after a host announced a change. */
export const BrowserTabsChangedSchema = z.object({
  type: z.literal("browser.tabs.changed"),
  payload: z.object({
    tabs: z.array(BrowserAutomationTabInfoSchema),
  }),
});

export type BrowserViewerCommand = z.infer<typeof BrowserViewerCommandSchema>;
export type BrowserTabExecuteRequest = z.infer<typeof BrowserTabExecuteRequestSchema>;
export type BrowserTabExecuteResponse = z.infer<typeof BrowserTabExecuteResponseSchema>;
export type BrowserTabsChanged = z.infer<typeof BrowserTabsChangedSchema>;
