import { z } from "zod";

// Daemon-managed provider CLIs: installed version, updates, and sign-in. Gated on
// `server_info.features.providerCli`. Long operations start with a request and report
// progress through `provider.cli.status.list`, which the app polls while one is running.

export const ProviderCliUpdateStatusSchema = z.enum(["idle", "running", "succeeded", "failed"]);
export const ProviderCliAuthStatusSchema = z.enum(["signed_in", "signed_out", "unknown"]);
export const ProviderCliLoginStatusSchema = z.enum(["running", "succeeded", "failed", "canceled"]);

export const ProviderCliUpdateStateSchema = z.object({
  supported: z.boolean(),
  status: ProviderCliUpdateStatusSchema,
  error: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

export const ProviderCliAuthStateSchema = z.object({
  supported: z.boolean(),
  status: ProviderCliAuthStatusSchema,
  account: z.string().nullable(),
});

export const ProviderCliLoginSessionSchema = z.object({
  status: ProviderCliLoginStatusSchema,
  /** First sign-in URL the CLI printed. */
  url: z.string().nullable(),
  /** Device code the CLI asks the user to enter on the sign-in page. */
  code: z.string().nullable(),
  /** Tail of the CLI output with terminal escapes removed. */
  output: z.string(),
  error: z.string().nullable(),
});

export const ProviderCliStatusSchema = z.object({
  provider: z.string(),
  installed: z.boolean(),
  version: z.string().nullable(),
  latestVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  /** Set when a custom command replaces the CLI, so Paseo does not manage it. */
  managedExternally: z.boolean(),
  update: ProviderCliUpdateStateSchema,
  auth: ProviderCliAuthStateSchema,
  login: ProviderCliLoginSessionSchema.nullable(),
});

export const ProviderCliStatusListRequestSchema = z.object({
  type: z.literal("provider.cli.status.list.request"),
  requestId: z.string(),
  /** Re-probe versions, latest releases, and sign-in state instead of using cached values. */
  refresh: z.boolean().optional(),
});

export const ProviderCliUpdateStartRequestSchema = z.object({
  type: z.literal("provider.cli.update.start.request"),
  requestId: z.string(),
  provider: z.string(),
});

export const ProviderCliLoginStartRequestSchema = z.object({
  type: z.literal("provider.cli.login.start.request"),
  requestId: z.string(),
  provider: z.string(),
});

export const ProviderCliLoginInputRequestSchema = z.object({
  type: z.literal("provider.cli.login.input.request"),
  requestId: z.string(),
  provider: z.string(),
  text: z.string(),
});

export const ProviderCliLoginCancelRequestSchema = z.object({
  type: z.literal("provider.cli.login.cancel.request"),
  requestId: z.string(),
  provider: z.string(),
});

export const ProviderCliStatusListResponseSchema = z.object({
  type: z.literal("provider.cli.status.list.response"),
  payload: z.object({
    requestId: z.string(),
    providers: z.array(ProviderCliStatusSchema),
    error: z.string().nullable(),
  }),
});

const ProviderCliAckPayloadSchema = z.object({
  requestId: z.string(),
  error: z.string().nullable(),
});

export const ProviderCliUpdateStartResponseSchema = z.object({
  type: z.literal("provider.cli.update.start.response"),
  payload: ProviderCliAckPayloadSchema,
});

export const ProviderCliLoginStartResponseSchema = z.object({
  type: z.literal("provider.cli.login.start.response"),
  payload: ProviderCliAckPayloadSchema,
});

export const ProviderCliLoginInputResponseSchema = z.object({
  type: z.literal("provider.cli.login.input.response"),
  payload: ProviderCliAckPayloadSchema,
});

export const ProviderCliLoginCancelResponseSchema = z.object({
  type: z.literal("provider.cli.login.cancel.response"),
  payload: ProviderCliAckPayloadSchema,
});

export type ProviderCliStatus = z.infer<typeof ProviderCliStatusSchema>;
export type ProviderCliUpdateState = z.infer<typeof ProviderCliUpdateStateSchema>;
export type ProviderCliAuthState = z.infer<typeof ProviderCliAuthStateSchema>;
export type ProviderCliLoginSession = z.infer<typeof ProviderCliLoginSessionSchema>;
