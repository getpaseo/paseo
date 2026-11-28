import { z } from "zod";
import { DaemonPermissionSchema } from "./daemon-permissions.js";

export const HelloClientPlatformSchema = z.enum([
  "macos",
  "linux",
  "windows",
  "ios",
  "android",
  "web",
  "unknown",
]);
export type HelloClientPlatform = z.infer<typeof HelloClientPlatformSchema>;

export const HelloClientKindSchema = z.enum([
  "desktop",
  "mobile",
  "web",
  "cli",
  "mcp",
  "hub",
  "daemon",
  "plugin",
]);
export type HelloClientKind = z.infer<typeof HelloClientKindSchema>;

export const HelloClientInfoSchema = z.object({
  name: z.string().max(128).optional(),
  platform: HelloClientPlatformSchema.optional(),
  kind: HelloClientKindSchema.optional(),
  peerServerId: z.string().max(256).optional(),
});
export type HelloClientInfo = z.infer<typeof HelloClientInfoSchema>;

export const ConnectedClientKindSchema = z.enum([
  "desktop",
  "mobile",
  "web",
  "cli",
  "mcp",
  "hub",
  "plugin",
  "unknown",
]);
export type ConnectedClientKind = z.infer<typeof ConnectedClientKindSchema>;

export const ConnectedClientTransportSchema = z.enum([
  "local_ipc",
  "local",
  "tailscale",
  "direct",
  "relay",
  "hub",
]);
export type ConnectedClientTransport = z.infer<typeof ConnectedClientTransportSchema>;

export const ConnectedClientSummarySchema = z.object({
  sessionId: z.string(),
  clientId: z.string(),
  isCurrentSession: z.boolean(),
  principalId: z.string(),
  kind: ConnectedClientKindSchema,
  name: z.string().nullable(),
  platform: z.string().nullable(),
  appVersion: z.string().nullable(),
  transport: ConnectedClientTransportSchema,
  securityMode: z.enum(["protected", "legacy"]).optional(),
  hubOrigin: z.string().nullable().optional(),
  permissions: z.array(DaemonPermissionSchema),
  attenuated: z.boolean(),
  connectedAt: z.string(),
  socketCount: z.number().int().nonnegative(),
});
export type ConnectedClientSummary = z.infer<typeof ConnectedClientSummarySchema>;

export const RoutedClientSummarySchema = z.object({
  sessionId: z.string(),
  sourceId: z.string(),
  name: z.string().nullable(),
  kind: ConnectedClientKindSchema,
  appVersion: z.string().nullable(),
  permissions: z.array(DaemonPermissionSchema),
  attenuated: z.boolean(),
  connectedAt: z.string(),
});
export type RoutedClientSummary = z.infer<typeof RoutedClientSummarySchema>;

export const InboundDaemonSummarySchema = z.object({
  sessionId: z.string(),
  peerServerId: z.string().nullable(),
  name: z.string().nullable(),
  appVersion: z.string().nullable(),
  principalId: z.string(),
  transport: ConnectedClientTransportSchema,
  securityMode: z.enum(["protected", "legacy"]).optional(),
  permissions: z.array(DaemonPermissionSchema),
  connectedAt: z.string(),
  socketCount: z.number().int().nonnegative(),
  routedSessions: z.array(RoutedClientSummarySchema),
});
export type InboundDaemonSummary = z.infer<typeof InboundDaemonSummarySchema>;

export const DaemonClientsSnapshotSchema = z.object({
  clients: z.array(ConnectedClientSummarySchema),
  inboundDaemons: z.array(InboundDaemonSummarySchema),
});
export type DaemonClientsSnapshot = z.infer<typeof DaemonClientsSnapshotSchema>;

export const DaemonClientsListRequestSchema = z.object({
  type: z.literal("daemon.clients.list.request"),
  requestId: z.string(),
  observe: z.boolean().optional(),
  includeInternal: z.boolean().optional(),
});

export const DaemonClientsListResponseSchema = z.object({
  type: z.literal("daemon.clients.list.response"),
  payload: z.object({
    requestId: z.string(),
    subscriptionId: z.string().optional(),
    clients: z.array(ConnectedClientSummarySchema),
    inboundDaemons: z.array(InboundDaemonSummarySchema),
  }),
});

export const DaemonClientsChangedSchema = z.object({
  type: z.literal("daemon.clients.changed"),
  payload: z.object({
    subscriptionId: z.string(),
    clients: z.array(ConnectedClientSummarySchema),
    inboundDaemons: z.array(InboundDaemonSummarySchema),
  }),
});

export type DaemonClientsListRequest = z.infer<typeof DaemonClientsListRequestSchema>;
export type DaemonClientsListResponse = z.infer<typeof DaemonClientsListResponseSchema>;
export type DaemonClientsChanged = z.infer<typeof DaemonClientsChangedSchema>;
