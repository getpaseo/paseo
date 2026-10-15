import { z } from "zod";

// Desktop-local IPC only. This is not part of the daemon WebSocket contract.
export const WidgetQuestionSchema = z.object({
  question: z.string(),
  header: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
  multiSelect: z.boolean(),
  allowOther: z.boolean(),
  allowEmpty: z.boolean(),
  placeholder: z.string().optional(),
});
export const WidgetRequestSchema = z.object({
  key: z.string().min(1),
  serverId: z.string().min(1),
  agentId: z.string().min(1),
  requestId: z.string().min(1),
  workspaceId: z.string().optional(),
  planCallId: z.string().optional(),
  planText: z.string().optional(),
  handoffDisabledReason: z.string().optional(),
  handoffProfiles: z.array(z.object({ id: z.string().min(1), name: z.string() })).optional(),
  project: z
    .object({
      name: z.string(),
      branchName: z.string(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      iconDataUri: z
        .string()
        .regex(/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+$/)
        .nullable()
        .optional(),
      emoji: z.string().nullable().optional(),
    })
    .optional(),
  agentTitle: z.string(),
  workspace: z.string(),
  kind: z.enum(["plan", "question"]),
  title: z.string(),
  planHtml: z.string(),
  questions: z.array(WidgetQuestionSchema),
  canApprove: z.boolean(),
});
export const WidgetLabelsSchema = z.object({
  plan: z.string(),
  question: z.string(),
  execute: z.string(),
  comment: z.string(),
  sendComment: z.string(),
  handoff: z.string(),
  noProfiles: z.string().optional(),
  submit: z.string(),
  next: z.string(),
  close: z.string(),
  minimize: z.string(),
  pending: z.string(),
  sent: z.string(),
  offline: z.string(),
  failed: z.string(),
});
export const WidgetSnapshotSchema = z.object({
  serverId: z.string().min(1),
  online: z.boolean(),
  requests: z.array(WidgetRequestSchema),
  labels: WidgetLabelsSchema,
});
const actionKey = { key: z.string().min(1) };
export const WidgetActionSchema = z.discriminatedUnion("type", [
  z.object({ ...actionKey, type: z.literal("approve") }),
  z.object({
    ...actionKey,
    type: z.literal("comment"),
    message: z.string().trim().min(1).max(100000),
  }),
  z.object({
    ...actionKey,
    type: z.literal("handoff"),
    profileId: z.string().min(1).optional(),
    planCallId: z.string().min(1),
    planText: z.string(),
  }),
  z.object({
    ...actionKey,
    type: z.literal("answer"),
    selections: z.array(z.array(z.number().int().nonnegative())),
    texts: z.array(z.string()),
  }),
]);
export const WidgetActionDeliverySchema = z.object({
  operationId: z.string().min(1),
  serverId: z.string().min(1),
  action: WidgetActionSchema,
});
export const WidgetActionResultSchema = z.object({
  operationId: z.string().min(1),
  error: z.string().nullable(),
});
export const WidgetActionProgressSchema = z.object({ operationId: z.string().min(1) });
export type WidgetRequest = z.infer<typeof WidgetRequestSchema>;
export type WidgetQuestion = z.infer<typeof WidgetQuestionSchema>;
export type WidgetLabels = z.infer<typeof WidgetLabelsSchema>;
export type WidgetSnapshot = z.infer<typeof WidgetSnapshotSchema>;
export type WidgetAction = z.infer<typeof WidgetActionSchema>;
export type WidgetActionDelivery = z.infer<typeof WidgetActionDeliverySchema>;
export type WidgetActionResult = z.infer<typeof WidgetActionResultSchema>;
export interface WidgetDisplayItem extends WidgetRequest {
  online: boolean;
}
export interface WidgetDisplay {
  requests: WidgetDisplayItem[];
  labels: WidgetLabels;
}
export interface AgentWidgetBridge {
  publish(snapshot: WidgetSnapshot): Promise<void>;
  result(result: WidgetActionResult): Promise<void>;
  progress(operationId: string): Promise<void>;
  onAction(listener: (delivery: WidgetActionDelivery) => void): () => void;
}
