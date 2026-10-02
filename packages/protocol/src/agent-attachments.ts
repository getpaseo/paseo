import { z } from "zod";
// COMPAT(githubAttachmentKinds): legacy wire attachment retained when

export const GitHubPrAttachmentSchema = z.object({
  type: z.literal("github_pr"),
  mimeType: z.literal("application/github-pr"),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  body: z.string().nullable().optional(),
  baseRefName: z.string().nullable().optional(),
  headRefName: z.string().nullable().optional(),
});

export const ForgeChangeRequestAttachmentSchema = z.object({
  type: z.literal("forge_change_request"),
  mimeType: z.literal("application/paseo-forge-change-request"),
  forge: z.string().optional().default("github"),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  body: z.string().nullable().optional(),
  projectPath: z.string().optional(),
  baseRefName: z.string().nullable().optional(),
  headRefName: z.string().nullable().optional(),
});

// COMPAT(githubAttachmentKinds): legacy wire attachment retained when

export const GitHubIssueAttachmentSchema = z.object({
  type: z.literal("github_issue"),
  mimeType: z.literal("application/github-issue"),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  body: z.string().nullable().optional(),
});

export const ForgeIssueAttachmentSchema = z.object({
  type: z.literal("forge_issue"),
  mimeType: z.literal("application/paseo-forge-issue"),
  forge: z.string().optional().default("github"),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  body: z.string().nullable().optional(),
  projectPath: z.string().optional(),
});

export const ExternalResourceAttachmentMetadataSchema = z.object({
  provider: z.string(),
  providerLabel: z.string(),
  resourceType: z.string(),
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
});

export const TextAttachmentSchema = z
  .object({
    type: z.literal("text"),
    mimeType: z.literal("text/plain"),
    contextKind: z.string().optional(),
    title: z.string().nullable().optional(),
    text: z.string(),
    externalResource: ExternalResourceAttachmentMetadataSchema.optional(),
  })
  .transform(({ contextKind, ...attachment }) => ({
    ...attachment,
    ...(contextKind === "chat_history" ? { contextKind } : {}),
  }));

export const ReviewAttachmentContextLineSchema = z.object({
  oldLineNumber: z.number().int().positive().nullable(),
  newLineNumber: z.number().int().positive().nullable(),
  type: z.enum(["add", "remove", "context"]),
  content: z.string(),
});

export const ReviewAttachmentCommentSchema = z.object({
  filePath: z.string(),
  side: z.enum(["old", "new"]),
  lineNumber: z.number().int().positive(),
  body: z.string(),
  context: z.object({
    hunkHeader: z.string(),
    targetLine: ReviewAttachmentContextLineSchema,
    lines: z.array(ReviewAttachmentContextLineSchema),
  }),
});

export const ReviewAttachmentSchema = z.object({
  type: z.literal("review"),
  mimeType: z.literal("application/paseo-review"),
  cwd: z.string(),
  mode: z.enum(["uncommitted", "base"]),
  baseRef: z.string().nullable().optional(),
  comments: z.array(ReviewAttachmentCommentSchema),
});

export const UploadedFileAttachmentSchema = z.object({
  type: z.literal("uploaded_file"),
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  path: z.string(),
});

export const AgentAttachmentSchema = z.discriminatedUnion("type", [
  ForgeChangeRequestAttachmentSchema,
  ForgeIssueAttachmentSchema,
  GitHubPrAttachmentSchema,
  GitHubIssueAttachmentSchema,
  TextAttachmentSchema,
  ReviewAttachmentSchema,
  UploadedFileAttachmentSchema,
]);

export const AgentPromptInputSchema = z.union([
  z.string(),
  z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string(), mimeType: z.undefined().optional() }),
      z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
      z.discriminatedUnion("type", [
        ForgeChangeRequestAttachmentSchema,
        ForgeIssueAttachmentSchema,
        GitHubPrAttachmentSchema,
        GitHubIssueAttachmentSchema,
        TextAttachmentSchema.in,
        ReviewAttachmentSchema,
        UploadedFileAttachmentSchema,
      ]),
    ]),
  ),
]);
