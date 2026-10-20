import { z } from "zod";

export const HostMetadataSchema = z.record(z.string().max(256), z.string().max(4096));
export const HostAddSchema = z.object({
  connection: z.string().min(1).max(16384),
  label: z.string().max(256).optional(),
  metadata: HostMetadataSchema.optional(),
  sourceKey: z.string().min(1).max(256).optional(),
});
export const HostUpdateSchema = z.object({
  label: z.string().max(256).nullable().optional(),
  metadata: HostMetadataSchema.optional(),
  enabled: z.boolean().optional(),
  connection: z.string().min(1).max(16384).optional(),
  replaceIdentity: z.boolean().optional(),
});
export const HostSummarySchema = z.object({
  registrationId: z.string(),
  serverId: z.string().nullable(),
  label: z.string().nullable(),
  source: z.object({ id: z.string(), key: z.string() }),
  metadata: HostMetadataSchema,
  enabled: z.boolean(),
  status: z.enum(["connecting", "online", "offline", "error", "disabled"]),
  targetDescription: z.string(),
  lastOnlineAt: z.string().nullable(),
  nextRetryAt: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export const HostDirectorySchema = z.object({
  self: z.object({ serverId: z.string(), label: z.string() }),
  hosts: z.array(HostSummarySchema),
});
export type HostAdd = z.infer<typeof HostAddSchema>;
export type HostUpdate = z.infer<typeof HostUpdateSchema>;
export type HostSummary = z.infer<typeof HostSummarySchema>;
export type HostDirectory = z.infer<typeof HostDirectorySchema>;

export const HostsListRequestSchema = z.object({
  type: z.literal("hosts.list.request"),
  requestId: z.string(),
  observe: z.boolean().optional(),
});
export const HostsAddRequestSchema = z.object({
  type: z.literal("hosts.add.request"),
  requestId: z.string(),
  input: HostAddSchema,
});
export const HostsUpdateRequestSchema = z.object({
  type: z.literal("hosts.update.request"),
  requestId: z.string(),
  registrationId: z.string(),
  patch: HostUpdateSchema,
});
export const HostsRemoveRequestSchema = z.object({
  type: z.literal("hosts.remove.request"),
  requestId: z.string(),
  registrationId: z.string(),
});
export const HostsRouteOpenRequestSchema = z.object({
  type: z.literal("hosts.route.open.request"),
  requestId: z.string(),
  serverId: z.string(),
  scopeId: z.string().min(1).max(256),
});
export const HostsRouteFrameRequestSchema = z.object({
  type: z.literal("hosts.route.frame.request"),
  routeId: z.string(),
  data: z.string().max(100 * 1024 * 1024),
  binary: z.literal(false),
});
export const HostsRouteCloseRequestSchema = z.object({
  type: z.literal("hosts.route.close.request"),
  routeId: z.string().optional(),
  scopeId: z.string().optional(),
});
export const HostsListResponseSchema = z.object({
  type: z.literal("hosts.list.response"),
  payload: z.object({
    requestId: z.string(),
    directory: HostDirectorySchema,
    subscriptionId: z.string().optional(),
  }),
});
export const HostsChangedSchema = z.object({
  type: z.literal("hosts.changed"),
  payload: z.object({ subscriptionId: z.string(), directory: HostDirectorySchema }),
});
export const HostsAddResponseSchema = z.object({
  type: z.literal("hosts.add.response"),
  payload: z.object({ requestId: z.string(), host: HostSummarySchema }),
});
export const HostsUpdateResponseSchema = z.object({
  type: z.literal("hosts.update.response"),
  payload: z.object({ requestId: z.string(), host: HostSummarySchema }),
});
export const HostsRemoveResponseSchema = z.object({
  type: z.literal("hosts.remove.response"),
  payload: z.object({ requestId: z.string() }),
});
export const HostsRouteOpenResponseSchema = z.object({
  type: z.literal("hosts.route.open.response"),
  payload: z.object({ requestId: z.string(), routeId: z.string() }),
});
export const HostsRouteFrameSchema = z.object({
  type: z.literal("hosts.route.frame"),
  payload: z.object({ subscriptionId: z.string(), data: z.string(), binary: z.literal(false) }),
});
export const HostsRouteClosedSchema = z.object({
  type: z.literal("hosts.route.closed"),
  payload: z.object({ subscriptionId: z.string(), code: z.string(), message: z.string() }),
});

// Logical B sessions are admitted under the authenticated physical link, never hello auth.
export const HostsLinkOpenRequestSchema = z.object({
  type: z.literal("hosts.link.open.request"),
  requestId: z.string(),
  channelId: z.string().min(1).max(256),
});
export const HostsLinkOpenResponseSchema = z.object({
  type: z.literal("hosts.link.open.response"),
  payload: z.object({ requestId: z.string(), routeId: z.string() }),
});
