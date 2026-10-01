import { z } from "zod";

export const BrowserTunnelConnectRequestSchema = z.object({
  type: z.literal("browser.tunnel.connect.request"),
  requestId: z.string(),
  workspaceId: z.string().min(1),
  browserId: z.string().min(1),
  origin: z.string().max(2048),
  localOrigin: z.string().max(2048),
});
export const BrowserTunnelConnectResponseSchema = z.object({
  type: z.literal("browser.tunnel.connect.response"),
  payload: z.object({
    requestId: z.string(),
    subscriptionId: z.string().optional(),
    error: z.string().nullable(),
  }),
});
export const BrowserTunnelSocketRequestSchema = z.object({
  type: z.literal("browser.tunnel.socket.request"),
  requestId: z.string(),
  subscriptionId: z.string().min(1),
  operation: z.enum(["write", "resume", "close"]),
  dataBase64: z.string().max(43692).optional(),
});
export const BrowserTunnelSocketResponseSchema = z.object({
  type: z.literal("browser.tunnel.socket.response"),
  payload: z.object({ requestId: z.string(), error: z.string().nullable() }),
});
// Bytes belong only to the source-owned connect subscription.
export const BrowserTunnelDataSchema = z.object({
  type: z.literal("browser.tunnel.data"),
  payload: z.object({
    subscriptionId: z.string().optional(),
    dataBase64: z.string().max(43692).optional(),
    ended: z.boolean().optional(),
    error: z.string().optional(),
  }),
});
