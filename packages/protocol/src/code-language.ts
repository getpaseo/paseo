import { z } from "zod";

export const CodePositionSchema = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
});
export const CodeRangeSchema = z.object({ start: CodePositionSchema, end: CodePositionSchema });
export const CodeLocationSchema = z.object({ path: z.string(), range: CodeRangeSchema });
export const CodeQueryResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hover"), text: z.string(), range: CodeRangeSchema.nullable() }),
  z.object({ kind: z.literal("locations"), locations: z.array(CodeLocationSchema) }),
  z.object({ kind: z.literal("stale") }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);
export const CodeDocumentRequestSchema = z.object({
  type: z.literal("code.language.sync.request"),
  requestId: z.string(),
  cwd: z.string(),
  path: z.string(),
  version: z.number().int().nonnegative(),
  content: z.string().nullable(),
});
export const CodeDocumentResponseSchema = z.object({
  type: z.literal("code.language.sync.response"),
  payload: z.object({ requestId: z.string(), error: z.string().nullable() }),
});
export const CodeQueryRequestSchema = z.object({
  type: z.literal("code.language.query.request"),
  requestId: z.string(),
  cwd: z.string(),
  path: z.string(),
  version: z.number().int().nonnegative().nullable(),
  position: CodePositionSchema,
  operation: z.enum(["hover", "definition", "references"]),
  targetContentId: z.string().optional(),
});
export const CodeQueryResponseSchema = z.object({
  type: z.literal("code.language.query.response"),
  payload: z.object({
    requestId: z.string(),
    version: z.number().nullable(),
    generation: z.string(),
    result: CodeQueryResultSchema,
  }),
});
export const CodeCancelRequestSchema = z.object({
  type: z.literal("code.language.cancel.request"),
  requestId: z.string(),
  queryId: z.string(),
});
export const CodeCancelResponseSchema = z.object({
  type: z.literal("code.language.cancel.response"),
  payload: z.object({ requestId: z.string() }),
});
export const CodeSnippetsRequestSchema = z.object({
  type: z.literal("code.language.snippets.request"),
  requestId: z.string(),
  cwd: z.string(),
  locations: z.array(CodeLocationSchema).max(100),
});
export const CodeSnippetsResponseSchema = z.object({
  type: z.literal("code.language.snippets.response"),
  payload: z.object({ requestId: z.string(), snippets: z.array(z.string()) }),
});
export type CodePosition = z.infer<typeof CodePositionSchema>;
export type CodeLocation = z.infer<typeof CodeLocationSchema>;
export type CodeQueryResult = z.infer<typeof CodeQueryResultSchema>;
export type CodeQuery = Omit<z.infer<typeof CodeQueryRequestSchema>, "type" | "requestId">;
export type CodeDocument = Omit<z.infer<typeof CodeDocumentRequestSchema>, "type" | "requestId">;
export function isTypeScriptFile(path: string): boolean {
  return /\.(?:[cm]?ts|tsx)$/i.test(path);
}
