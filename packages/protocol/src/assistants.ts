import { z } from "zod";

export const AssistantIdSchema = z.string().regex(/^ast_[a-f0-9]{32}$/);
export const AssistantTemplateIdSchema = z.string().regex(/^tpl_[a-f0-9]{32}$/);
const NameSchema = z.string().min(1).max(120);
const RevisionSchema = z.number().int().positive();
const SequenceSchema = z.number().int().nonnegative();

export const AssistantConfigurationSchema = z.object({
  instructions: z.string().max(1000),
  context: z.string().max(8000),
  voice: z.string().max(120).nullable(),
  backendModel: z.string().max(200).nullable(),
  backendThinkingOptionId: z.string().max(80).nullable(),
});
export type AssistantConfiguration = z.infer<typeof AssistantConfigurationSchema>;

export const DEFAULT_ASSISTANT_CONFIGURATION: AssistantConfiguration = {
  instructions: "",
  context: "",
  voice: null,
  backendModel: null,
  backendThinkingOptionId: null,
};

export const AssistantTemplateSchema = z.object({
  id: AssistantTemplateIdSchema,
  name: NameSchema,
  configuration: AssistantConfigurationSchema,
  revision: RevisionSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AssistantTemplate = z.infer<typeof AssistantTemplateSchema>;

export const AssistantSchema = z.object({
  id: AssistantIdSchema,
  name: NameSchema,
  templateId: AssistantTemplateIdSchema.nullable(),
  configuration: AssistantConfigurationSchema,
  revision: RevisionSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  summary: z.string().max(8000),
  summaryThroughSeq: SequenceSchema,
  lastSeq: SequenceSchema,
});
export type Assistant = z.infer<typeof AssistantSchema>;

const HistoryBase = {
  seq: RevisionSchema,
  callId: z.string(),
  createdAt: z.string(),
};
export const AssistantHistoryEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    ...HistoryBase,
    kind: z.literal("transcript"),
    role: z.enum(["user", "assistant"]),
    text: z.string().max(16_000),
  }),
  z.object({ ...HistoryBase, kind: z.literal("call_started") }),
  z.object({ ...HistoryBase, kind: z.literal("call_ended"), cause: z.string() }),
  z.object({
    ...HistoryBase,
    kind: z.literal("delegation"),
    requestId: z.string(),
    description: z.string().max(1000),
    ok: z.boolean(),
    errorCode: z.string().optional(),
  }),
]);
export type AssistantHistoryEntry = z.infer<typeof AssistantHistoryEntrySchema>;

const RequestFields = { requestId: z.string() };
export const AssistantListRequestSchema = z.object({
  ...RequestFields,
  type: z.literal("assistant.list.request"),
});
export const AssistantGetRequestSchema = z.object({
  ...RequestFields,
  type: z.literal("assistant.get.request"),
  assistantId: AssistantIdSchema,
  beforeSeq: RevisionSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export const AssistantCreateRequestSchema = z.object({
  ...RequestFields,
  type: z.literal("assistant.create.request"),
  name: NameSchema,
  templateId: AssistantTemplateIdSchema.optional(),
  configuration: AssistantConfigurationSchema.optional(),
});
export const AssistantUpdateRequestSchema = z.object({
  ...RequestFields,
  type: z.literal("assistant.update.request"),
  assistantId: AssistantIdSchema,
  expectedRevision: RevisionSchema,
  name: NameSchema,
  configuration: AssistantConfigurationSchema,
});
export const AssistantDeleteRequestSchema = z.object({
  ...RequestFields,
  type: z.literal("assistant.delete.request"),
  assistantId: AssistantIdSchema,
});
export const AssistantCompactRequestSchema = z.object({
  ...RequestFields,
  type: z.literal("assistant.compact.request"),
  assistantId: AssistantIdSchema,
  expectedRevision: RevisionSchema,
  throughSeq: SequenceSchema,
  summary: z.string().max(8000),
});
export const AssistantTemplateListRequestSchema = z.object({
  ...RequestFields,
  type: z.literal("assistant.template.list.request"),
});
export const AssistantTemplateSaveRequestSchema = z.object({
  ...RequestFields,
  type: z.literal("assistant.template.save.request"),
  templateId: AssistantTemplateIdSchema.optional(),
  expectedRevision: RevisionSchema.optional(),
  name: NameSchema,
  configuration: AssistantConfigurationSchema,
});
export const AssistantTemplateDeleteRequestSchema = z.object({
  ...RequestFields,
  type: z.literal("assistant.template.delete.request"),
  templateId: AssistantTemplateIdSchema,
});

function response<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({ type: z.literal(type), payload: z.object({ ...RequestFields, ...shape }) });
}

export const AssistantListResponseSchema = response("assistant.list.response", {
  assistants: z.array(AssistantSchema),
});
export const AssistantGetResponseSchema = response("assistant.get.response", {
  assistant: AssistantSchema,
  history: z.array(AssistantHistoryEntrySchema),
  hasMore: z.boolean(),
});
export const AssistantCreateResponseSchema = response("assistant.create.response", {
  assistant: AssistantSchema,
});
export const AssistantUpdateResponseSchema = response("assistant.update.response", {
  assistant: AssistantSchema,
});
export const AssistantDeleteResponseSchema = response("assistant.delete.response", {});
export const AssistantCompactResponseSchema = response("assistant.compact.response", {
  assistant: AssistantSchema,
});
export const AssistantTemplateListResponseSchema = response("assistant.template.list.response", {
  templates: z.array(AssistantTemplateSchema),
});
export const AssistantTemplateSaveResponseSchema = response("assistant.template.save.response", {
  template: AssistantTemplateSchema,
});
export const AssistantTemplateDeleteResponseSchema = response(
  "assistant.template.delete.response",
  {},
);

export const ASSISTANT_REQUEST_SCHEMAS = [
  AssistantListRequestSchema,
  AssistantGetRequestSchema,
  AssistantCreateRequestSchema,
  AssistantUpdateRequestSchema,
  AssistantDeleteRequestSchema,
  AssistantCompactRequestSchema,
  AssistantTemplateListRequestSchema,
  AssistantTemplateSaveRequestSchema,
  AssistantTemplateDeleteRequestSchema,
] as const;
export const ASSISTANT_RESPONSE_SCHEMAS = [
  AssistantListResponseSchema,
  AssistantGetResponseSchema,
  AssistantCreateResponseSchema,
  AssistantUpdateResponseSchema,
  AssistantDeleteResponseSchema,
  AssistantCompactResponseSchema,
  AssistantTemplateListResponseSchema,
  AssistantTemplateSaveResponseSchema,
  AssistantTemplateDeleteResponseSchema,
] as const;
export const AssistantRequestSchema = z.discriminatedUnion("type", ASSISTANT_REQUEST_SCHEMAS);
export const AssistantResponseSchema = z.discriminatedUnion("type", ASSISTANT_RESPONSE_SCHEMAS);
export type AssistantRequest = z.infer<typeof AssistantRequestSchema>;
export type AssistantResponse = z.infer<typeof AssistantResponseSchema>;
