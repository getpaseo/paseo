import { z } from "zod";

import { DeliveryIdSchema, DeliveryRecordSchema, MAX_DELIVERY_PAGE_SIZE } from "./deliveries.js";

/** Leave room for the plugin-process host response envelope and its error path. */
export const MAX_PLUGIN_HOST_DELIVERY_GET_RESPONSE_BYTES = 192 * 1024;

/** Bounds applied to authority values crossing the plugin process boundary. */
export const MAX_PLUGIN_AUTHORITY_STRING_BYTES = 512;
export const MAX_PLUGIN_AUTHORITY_LABELS = 128;
/** Reserve one final label slot for daemon-owned child parentage. */
export const MAX_PLUGIN_HOST_CHILD_LABELS = MAX_PLUGIN_AUTHORITY_LABELS - 1;
export const MAX_PLUGIN_HOST_WORKTREE_ID_BYTES = 256;
export const MAX_PLUGIN_HOST_NONCE_BYTES = 128;

const authorityTextEncoder = new TextEncoder();
const AuthorityStringSchema = z
  .string()
  .min(1)
  .max(MAX_PLUGIN_AUTHORITY_STRING_BYTES)
  .refine(
    (value) => authorityTextEncoder.encode(value).byteLength <= MAX_PLUGIN_AUTHORITY_STRING_BYTES,
    `must be at most ${MAX_PLUGIN_AUTHORITY_STRING_BYTES} UTF-8 bytes`,
  )
  .refine((value) => value.trim() === value, "must not have leading or trailing whitespace");
const WorktreeIdSchema = z
  .string()
  .min(1)
  .max(MAX_PLUGIN_HOST_WORKTREE_ID_BYTES)
  .refine(
    (value) => authorityTextEncoder.encode(value).byteLength <= MAX_PLUGIN_HOST_WORKTREE_ID_BYTES,
    `must be at most ${MAX_PLUGIN_HOST_WORKTREE_ID_BYTES} UTF-8 bytes`,
  )
  .refine((value) => value.trim() === value, "must not have leading or trailing whitespace");
const CapabilityNonceSchema = z
  .string()
  .min(1)
  .max(MAX_PLUGIN_HOST_NONCE_BYTES)
  .refine(
    (value) => authorityTextEncoder.encode(value).byteLength <= MAX_PLUGIN_HOST_NONCE_BYTES,
    `must be at most ${MAX_PLUGIN_HOST_NONCE_BYTES} UTF-8 bytes`,
  )
  .refine((value) => value.trim() === value, "must not have leading or trailing whitespace");
const KnownStringSchema = z.discriminatedUnion("known", [
  z.object({ known: z.literal(true), value: AuthorityStringSchema }).strict(),
  z.object({ known: z.literal(false) }).strict(),
]);
const AuthorityLabelsSchema = z
  .record(AuthorityStringSchema, AuthorityStringSchema)
  .refine((labels) => Object.keys(labels).length <= MAX_PLUGIN_AUTHORITY_LABELS);
const PluginHostChildLabelsSchema = AuthorityLabelsSchema.refine(
  (labels) => Object.keys(labels).length <= MAX_PLUGIN_HOST_CHILD_LABELS,
);

export const PluginFilesystemSecurityCeilingSchema = z.enum([
  "none",
  "workspace",
  "unrestricted",
  "unknown",
]);
export const PluginNetworkSecurityCeilingSchema = z.enum([
  "none",
  "restricted",
  "unrestricted",
  "unknown",
]);
export const PluginApprovalSecurityCeilingSchema = z.enum([
  "none",
  "interactive",
  "preapproved",
  "unknown",
]);
export const PluginUnattendedSecurityCeilingSchema = z.enum(["forbidden", "allowed", "unknown"]);

export const PluginSecurityCeilingSchema = z
  .object({
    filesystem: PluginFilesystemSecurityCeilingSchema,
    network: PluginNetworkSecurityCeilingSchema,
    approvals: PluginApprovalSecurityCeilingSchema,
    unattended: PluginUnattendedSecurityCeilingSchema,
  })
  .strict();

export const PluginAgentSnapshotSchema = z
  .object({
    id: AuthorityStringSchema,
    workspaceId: z.string().max(MAX_PLUGIN_AUTHORITY_STRING_BYTES),
    provider: AuthorityStringSchema,
    status: z.enum(["initializing", "idle", "running", "error", "closed"]),
    createdAt: AuthorityStringSchema,
    updatedAt: AuthorityStringSchema,
    lastActivityAt: AuthorityStringSchema,
    title: z.string().max(MAX_PLUGIN_AUTHORITY_STRING_BYTES).nullable(),
    cwd: AuthorityStringSchema,
    model: z.string().max(MAX_PLUGIN_AUTHORITY_STRING_BYTES).nullable(),
    currentModeId: z.string().max(MAX_PLUGIN_AUTHORITY_STRING_BYTES).nullable(),
    thinkingOptionId: z.string().max(MAX_PLUGIN_AUTHORITY_STRING_BYTES).nullable(),
    requiresAttention: z.boolean(),
    attentionReason: z.enum(["finished", "error", "permission"]).nullable(),
    parentAgentId: z.string().max(MAX_PLUGIN_AUTHORITY_STRING_BYTES).nullable(),
    labels: AuthorityLabelsSchema,
  })
  .strict();

export const PluginWorkspaceSnapshotSchema = z
  .object({
    id: AuthorityStringSchema,
    projectId: AuthorityStringSchema,
    projectDisplayName: z.string().max(MAX_PLUGIN_AUTHORITY_STRING_BYTES),
    projectRootPath: AuthorityStringSchema,
    directory: AuthorityStringSchema,
    projectKind: z.enum(["git", "non_git", "directory"]),
    kind: z.enum(["directory", "local_checkout", "checkout", "worktree"]),
    name: AuthorityStringSchema,
    title: z.string().max(MAX_PLUGIN_AUTHORITY_STRING_BYTES).nullable(),
    status: z.enum(["needs_input", "failed", "running", "attention", "done"]),
    statusEnteredAt: AuthorityStringSchema.nullable(),
    archivingAt: AuthorityStringSchema.nullable(),
    diffStat: z
      .object({
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const PluginCallerAuthoritySchema = z
  .object({
    callerAgentId: AuthorityStringSchema,
    agent: PluginAgentSnapshotSchema,
    workspace: PluginWorkspaceSnapshotSchema.nullable(),
    effective: z
      .object({
        provider: KnownStringSchema,
        model: KnownStringSchema,
        thinking: KnownStringSchema,
        providerSessionId: KnownStringSchema,
      })
      .strict(),
    securityCeiling: PluginSecurityCeilingSchema,
  })
  .strict();

export type PluginCallerAuthorityWire = z.infer<typeof PluginCallerAuthoritySchema>;

export const PluginHostDeliveryGetOptionsSchema = z
  .object({
    deliveryId: AuthorityStringSchema.optional(),
    includeAcknowledged: z.boolean().optional(),
    cursor: AuthorityStringSchema.optional(),
    limit: z.number().int().positive().max(MAX_DELIVERY_PAGE_SIZE).optional(),
  })
  .strict();

export const PluginHostDeliverySendOptionsSchema = z
  .object({
    // A plugin delivery is retried across reconnects, so its id is the
    // bounded idempotency key rather than a daemon-generated per-attempt id.
    deliveryId: DeliveryIdSchema,
    messageId: AuthorityStringSchema.optional(),
  })
  .strict();

const HostRequestBaseSchema = z
  .object({
    requestId: AuthorityStringSchema,
    invocationId: AuthorityStringSchema,
    generation: z.number().int().positive(),
    installationId: AuthorityStringSchema,
    // COMPAT(pluginHostCapabilityNonce): optional for old private IPC peers;
    // new runtimes populate it and reject responses without an exact match.
    capabilityNonce: CapabilityNonceSchema.optional(),
  })
  .strict();

export const PluginHostDeliverySendRequestSchema = HostRequestBaseSchema.extend({
  type: z.literal("plugin.host.delivery.send.request"),
  payload: z.unknown(),
  options: PluginHostDeliverySendOptionsSchema,
}).strict();

export const PluginHostDeliveryGetRequestSchema = HostRequestBaseSchema.extend({
  type: z.literal("plugin.host.delivery.get.request"),
  options: PluginHostDeliveryGetOptionsSchema.optional(),
}).strict();

export const PluginHostDeliveryAcknowledgeRequestSchema = HostRequestBaseSchema.extend({
  type: z.literal("plugin.host.delivery.acknowledge.request"),
  deliveryId: AuthorityStringSchema,
}).strict();

export const PluginHostChildCreateRequestSchema = HostRequestBaseSchema.extend({
  type: z.literal("plugin.host.child.create.request"),
  options: z
    .object({
      title: AuthorityStringSchema.optional(),
      prompt: z
        .string()
        .max(16 * 1024)
        .optional(),
      worktreeId: WorktreeIdSchema.optional(),
      labels: PluginHostChildLabelsSchema.optional(),
    })
    .strict()
    .optional(),
}).strict();

export const PluginHostWorktreeCreateRequestSchema = HostRequestBaseSchema.extend({
  type: z.literal("plugin.host.worktree.create.request"),
  options: z
    .object({
      name: AuthorityStringSchema.optional(),
      branch: AuthorityStringSchema.optional(),
    })
    .strict()
    .optional(),
}).strict();

export const PluginHostWorktreeRemoveRequestSchema = HostRequestBaseSchema.extend({
  type: z.literal("plugin.host.worktree.remove.request"),
  id: WorktreeIdSchema,
}).strict();

export const PluginHostCancelRequestSchema = z
  .object({
    type: z.literal("plugin.host.cancel.request"),
    requestId: AuthorityStringSchema,
    invocationId: AuthorityStringSchema,
    generation: z.number().int().positive(),
    installationId: AuthorityStringSchema,
    capabilityNonce: CapabilityNonceSchema.optional(),
    targetRequestId: AuthorityStringSchema.optional(),
  })
  .strict();

export const PluginHostRequestSchema = z.discriminatedUnion("type", [
  PluginHostDeliverySendRequestSchema,
  PluginHostDeliveryGetRequestSchema,
  PluginHostDeliveryAcknowledgeRequestSchema,
  PluginHostChildCreateRequestSchema,
  PluginHostWorktreeCreateRequestSchema,
  PluginHostWorktreeRemoveRequestSchema,
  PluginHostCancelRequestSchema,
]);
export type PluginHostRequest = z.infer<typeof PluginHostRequestSchema>;

const HostResponseBaseSchema = z
  .object({
    requestId: AuthorityStringSchema,
    invocationId: AuthorityStringSchema,
    generation: z.number().int().positive(),
    installationId: AuthorityStringSchema,
    capabilityNonce: CapabilityNonceSchema.optional(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z
      .string()
      .max(16 * 1024)
      .optional(),
  })
  .strict();

function hostResponseSchema<const Type extends string, T extends z.ZodType>(type: Type, result: T) {
  return HostResponseBaseSchema.extend({
    type: z.literal(type),
    result: result.optional(),
  }).strict();
}

const DeliveryPageSchema = z
  .object({
    delivery: DeliveryRecordSchema.nullable(),
    deliveries: z.array(DeliveryRecordSchema).max(100),
    nextCursor: AuthorityStringSchema.nullable(),
  })
  .strict();

const HostedChildSchema = z
  .object({
    agentId: AuthorityStringSchema,
    parentAgentId: AuthorityStringSchema,
    workspaceId: AuthorityStringSchema.nullable(),
    cwd: AuthorityStringSchema,
    provider: AuthorityStringSchema,
    model: AuthorityStringSchema.nullable(),
    thinking: AuthorityStringSchema.nullable(),
  })
  .strict();

const ManagedWorktreeSchema = z
  .object({
    id: WorktreeIdSchema,
    workspace: PluginWorkspaceSnapshotSchema,
    cwd: AuthorityStringSchema,
  })
  .strict();

export const PluginHostResponseSchema = z.union([
  hostResponseSchema("plugin.host.delivery.send.response", DeliveryRecordSchema),
  hostResponseSchema("plugin.host.delivery.get.response", DeliveryPageSchema),
  hostResponseSchema("plugin.host.delivery.acknowledge.response", DeliveryRecordSchema),
  hostResponseSchema("plugin.host.child.create.response", HostedChildSchema),
  hostResponseSchema("plugin.host.worktree.create.response", ManagedWorktreeSchema),
  hostResponseSchema("plugin.host.worktree.remove.response", z.undefined()),
  hostResponseSchema("plugin.host.cancel.response", z.undefined()),
]);
export type PluginHostResponse = z.infer<typeof PluginHostResponseSchema>;

/** Enforce the response envelope invariants that are not represented by the operation union. */
export function assertPluginHostResponse(response: PluginHostResponse): void {
  if (response.ok) {
    if (
      response.result === undefined &&
      response.type !== "plugin.host.worktree.remove.response" &&
      response.type !== "plugin.host.cancel.response"
    ) {
      throw new Error(`Plugin host ${response.type} success response has no result`);
    }
    return;
  }
  if (response.error === undefined || response.error.length === 0) {
    throw new Error(`Plugin host ${response.type} failure response has no error`);
  }
  if (response.result !== undefined) {
    throw new Error(`Plugin host ${response.type} failure response has a result`);
  }
}

export const PluginHostDeliveryRecordSchema = DeliveryRecordSchema;
