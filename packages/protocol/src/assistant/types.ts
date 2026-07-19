import { z } from "zod";

export const AssistantMemoryDetailFileSchema = z.object({
  id: z.string().min(1),
  title: z.string().default(""),
  path: z.string().min(1),
  charCount: z.number().int().nonnegative(),
  content: z.string().default(""),
});
export type AssistantMemoryDetailFile = z.infer<typeof AssistantMemoryDetailFileSchema>;

export const AssistantMemoryFilesSchema = z
  .object({
    summaryPath: z.string().default(""),
    detailFiles: z.array(AssistantMemoryDetailFileSchema).default([]),
  })
  .default({ summaryPath: "", detailFiles: [] });
export type AssistantMemoryFiles = z.infer<typeof AssistantMemoryFilesSchema>;

export const AssistantSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
  description: z.string().default(""),
  prompt: z.string(),
  memoryEnabled: z.boolean(),
  memory: z.string(),
  memorySummary: z.string().default(""),
  memoryFiles: AssistantMemoryFilesSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Assistant = z.infer<typeof AssistantSchema>;

export const AssistantCreateInputSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  prompt: z.string(),
  memoryEnabled: z.boolean().optional(),
  memory: z.string().optional(),
});
export type AssistantCreateInput = z.infer<typeof AssistantCreateInputSchema>;

export const AssistantUpdateInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  memoryEnabled: z.boolean().optional(),
  memory: z.string().optional(),
  memoryAppend: z.string().optional(),
  memorySummary: z.string().optional(),
  memoryDetailFileEdits: z
    .array(
      z.object({
        id: z.string().min(1),
        content: z.string(),
      }),
    )
    .optional(),
});
export type AssistantUpdateInput = z.infer<typeof AssistantUpdateInputSchema>;
