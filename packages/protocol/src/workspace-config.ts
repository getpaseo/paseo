import { z } from "zod";

export const MutableStructuredGenerationProviderSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    thinkingOptionId: z.string().min(1).optional(),
  })
  .passthrough();

export const WorkspaceGitWorkflowConfigSchema = z
  .object({
    reviewProfileId: z.string().optional(),
    deliveryProfileId: z.string().optional(),
    reviewModel: MutableStructuredGenerationProviderSchema.nullable().optional(),
    commitModel: MutableStructuredGenerationProviderSchema.nullable().optional(),
    prModel: MutableStructuredGenerationProviderSchema.nullable().optional(),
    reviewPrompt: z.string().optional(),
    createPrPrompt: z.string().optional(),
    commitAndPushPrompt: z.string().optional(),
  })
  .strict();
export type WorkspaceGitWorkflowConfig = z.infer<typeof WorkspaceGitWorkflowConfigSchema>;
