import { z } from "zod";

export const TunnelStabilitySchema = z.enum(["ephemeral", "stable"]);

export const TunnelExposureStateSchema = z.enum([
  "connecting",
  "ready",
  "reconnecting",
  "error",
  "closed",
]);

export const TunnelProviderAvailabilitySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    detail: z.string().optional(),
  }),
  z.object({
    status: z.literal("unavailable"),
    reason: z.string(),
    installUrl: z.string().optional(),
    fixHint: z.string().optional(),
  }),
]);

export const TunnelProviderInfoSchema = z.object({
  id: z.string(),
  pluginId: z.string(),
  label: z.string(),
  description: z.string().optional(),
  docsUrl: z.string().optional(),
  availability: TunnelProviderAvailabilitySchema,
});

export const TunnelExposureTargetSchema = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  label: z.string().optional(),
  slug: z.string().optional(),
});

export const TunnelExposureSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  target: TunnelExposureTargetSchema,
  state: TunnelExposureStateSchema,
  url: z.string().nullable(),
  stability: TunnelStabilitySchema.nullable(),
  detail: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type TunnelStabilityWire = z.infer<typeof TunnelStabilitySchema>;
export type TunnelExposureState = z.infer<typeof TunnelExposureStateSchema>;
export type TunnelProviderAvailability = z.infer<typeof TunnelProviderAvailabilitySchema>;
export type TunnelProviderInfo = z.infer<typeof TunnelProviderInfoSchema>;
export type TunnelExposureTarget = z.infer<typeof TunnelExposureTargetSchema>;
export type TunnelExposure = z.infer<typeof TunnelExposureSchema>;

export const TunnelProvidersListRequestSchema = z.object({
  type: z.literal("tunnel.providers.list.request"),
  requestId: z.string(),
});

export const TunnelProvidersListResponseSchema = z.object({
  type: z.literal("tunnel.providers.list.response"),
  payload: z.object({
    requestId: z.string(),
    providers: z.array(TunnelProviderInfoSchema),
  }),
});

export const TunnelExposuresListRequestSchema = z.object({
  type: z.literal("tunnel.exposures.list.request"),
  requestId: z.string(),
  observe: z.boolean().optional(),
});

export const TunnelExposuresListResponseSchema = z.object({
  type: z.literal("tunnel.exposures.list.response"),
  payload: z.object({
    requestId: z.string(),
    exposures: z.array(TunnelExposureSchema),
    subscriptionId: z.string().optional(),
  }),
});

export const TunnelExposureChangedSchema = z.object({
  type: z.literal("tunnel.exposure.changed"),
  payload: z.object({
    subscriptionId: z.string(),
    exposure: TunnelExposureSchema,
  }),
});

export const TunnelExposureOpenRequestSchema = z.object({
  type: z.literal("tunnel.exposure.open.request"),
  requestId: z.string(),
  providerId: z.string().min(1).max(256),
  host: z.string().min(1).max(256),
  port: z.number().int().min(1).max(65535),
  id: z.string().min(1).max(256).optional(),
  label: z.string().max(256).optional(),
  slug: z.string().max(256).optional(),
});

export const TunnelExposureOpenResponseSchema = z.object({
  type: z.literal("tunnel.exposure.open.response"),
  payload: z.object({
    requestId: z.string(),
    exposure: TunnelExposureSchema,
  }),
});

export const TunnelExposureCloseRequestSchema = z.object({
  type: z.literal("tunnel.exposure.close.request"),
  requestId: z.string(),
  exposureId: z.string().min(1).max(256),
});

export const TunnelExposureCloseResponseSchema = z.object({
  type: z.literal("tunnel.exposure.close.response"),
  payload: z.object({
    requestId: z.string(),
    exposureId: z.string(),
    closed: z.boolean(),
  }),
});
