import { z } from "zod";
export const InteractiveStateSchema = z.record(
  z.string().max(64),
  z.union([z.string().max(65536), z.number().finite(), z.boolean(), z.null()]),
);
export type InteractiveState = z.infer<typeof InteractiveStateSchema>;
export const InteractiveDocumentSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string(),
  title: z.string().min(1).max(200),
  summary: z.string().max(10000),
  source: z.string().max(131072),
  state: InteractiveStateSchema,
  revision: z.number().int().nonnegative(),
});
export type InteractiveDocument = z.infer<typeof InteractiveDocumentSchema>;
export const InteractiveReferenceSchema = z.object({
  documentId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
});

export const DeepenReferenceSchema = z.object({
  messageId: z.string().optional(),
  cursor: z.object({ epoch: z.string(), seq: z.number().int().nonnegative() }).optional(),
});
