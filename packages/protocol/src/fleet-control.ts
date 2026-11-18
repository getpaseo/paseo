import { z } from "zod";

export const FLEET_CONTROL_CONTRACT_VERSION = "fleet-control.v1" as const;
export const FLEET_CONTROL_PORTFOLIO_AGENT_ID = "5353a509-71ba-4b79-93ac-769b6bace206" as const;

const AsciiSchema = z
  .string()
  .min(1)
  .regex(/^[\x20-\x7e]+$/u);
const UuidSchema = AsciiSchema.pipe(z.uuid());
export const FleetControlDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
export const FleetControlActionSchema = z.enum(["pause", "resume"]);
export type FleetControlAction = z.infer<typeof FleetControlActionSchema>;
export const FleetControlStateSchema = z.enum(["open", "paused"]);

export const FleetControlMarkerSchema = z.tuple([
  z.literal(FLEET_CONTROL_CONTRACT_VERSION),
  UuidSchema,
  FleetControlStateSchema,
  z.number().int().nonnegative().safe(),
  UuidSchema.nullable(),
  UuidSchema,
]);
export type FleetControlMarker = z.infer<typeof FleetControlMarkerSchema>;

export const FleetControlAdmittedRunSchema = z.object({
  agentId: UuidSchema,
  turnId: AsciiSchema,
});

export const FleetControlStrictResultSchema = z.object({
  contractVersion: z.literal(FLEET_CONTROL_CONTRACT_VERSION),
  operationRequestId: UuidSchema,
  commitmentId: UuidSchema,
  action: FleetControlActionSchema,
  portfolioAgentId: UuidSchema,
  before: FleetControlMarkerSchema,
  after: FleetControlMarkerSchema,
  beforeDigest: FleetControlDigestSchema,
  afterDigest: FleetControlDigestSchema,
  revision: z.number().int().nonnegative().safe(),
  changed: z.boolean(),
  admittedRun: FleetControlAdmittedRunSchema,
});
export type FleetControlStrictResult = z.infer<typeof FleetControlStrictResultSchema>;

export const FleetControlLifecycleSchema = z.enum([
  "executing",
  "awaiting_confirmation",
  "outcome_unknown",
  "completed",
  "rejected",
  "failed",
]);

export const FleetControlReceiptSchema = z.object({
  contractVersion: z.literal(FLEET_CONTROL_CONTRACT_VERSION),
  operationRequestId: UuidSchema,
  commitmentId: UuidSchema,
  action: FleetControlActionSchema,
  expectedPriorDigest: FleetControlDigestSchema,
  expectedPortfolioAgentId: UuidSchema,
  fingerprint: FleetControlDigestSchema,
  lifecycle: FleetControlLifecycleSchema,
  code: AsciiSchema.optional(),
  strictResult: FleetControlStrictResultSchema.optional(),
  ledgerWriteStarted: z.boolean(),
  admittedRun: FleetControlAdmittedRunSchema.optional(),
});
export type FleetControlReceipt = z.infer<typeof FleetControlReceiptSchema>;

const OperationFields = {
  requestId: AsciiSchema,
  operationRequestId: UuidSchema,
  commitmentId: UuidSchema,
} as const;

export const FleetCommitmentOperateRequestSchema = z.object({
  type: z.literal("fleet.commitment.operate.request"),
  ...OperationFields,
  action: FleetControlActionSchema,
  expectedPriorDigest: FleetControlDigestSchema,
  expectedPortfolioAgentId: UuidSchema,
});
export type FleetCommitmentOperateRequest = z.infer<typeof FleetCommitmentOperateRequestSchema>;

export const FleetCommitmentOperateResponseSchema = z.object({
  type: z.literal("fleet.commitment.operate.response"),
  payload: z.object({ requestId: AsciiSchema, receipt: FleetControlReceiptSchema }),
});

export const FleetCommitmentReadRequestSchema = z.object({
  type: z.literal("fleet.commitment.read.request"),
  requestId: AsciiSchema,
  commitmentId: UuidSchema,
});
export type FleetCommitmentReadRequest = z.infer<typeof FleetCommitmentReadRequestSchema>;

export const FleetCommitmentReadResponseSchema = z.object({
  type: z.literal("fleet.commitment.read.response"),
  payload: z.object({
    requestId: AsciiSchema,
    commitmentId: UuidSchema,
    marker: FleetControlMarkerSchema,
    digest: FleetControlDigestSchema,
  }),
});

export const FleetCommitmentConfirmRequestSchema = z.object({
  type: z.literal("fleet.commitment.confirm.request"),
  ...OperationFields,
});
export type FleetCommitmentConfirmRequest = z.infer<typeof FleetCommitmentConfirmRequestSchema>;

export const FleetCommitmentConfirmResponseSchema = z.object({
  type: z.literal("fleet.commitment.confirm.response"),
  payload: z.object({ requestId: AsciiSchema, receipt: FleetControlReceiptSchema }),
});

export type FleetCommitmentOperateResponse = z.infer<typeof FleetCommitmentOperateResponseSchema>;
export type FleetCommitmentReadResponse = z.infer<typeof FleetCommitmentReadResponseSchema>;
export type FleetCommitmentConfirmResponse = z.infer<typeof FleetCommitmentConfirmResponseSchema>;
