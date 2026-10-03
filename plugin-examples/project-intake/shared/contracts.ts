import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const AssessmentInputSchema = z.object({
  cwd: z.string().min(1),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  projectRootPath: z.string().optional(),
  text: z.string().max(65536),
  executionId: z.string(),
  idempotencyKey: z.string().min(1).max(512),
});

export const AssessmentSchema = z.object({
  showDecision: z.boolean(),
  currentName: z.string(),
  proposedName: z.string(),
  parentPath: z.string(),
  recommendation: z.enum(["current", "new"]),
  explanation: z.string(),
  source: z.enum(["jev", "local"]),
  confidence: z.number().min(0).max(1).optional(),
  timeout: z
    .object({ seconds: z.number().int().positive(), choiceId: z.enum(["current", "new"]) })
    .optional(),
});

export const assessProject = defineRpc({
  name: "project.assess",
  input: AssessmentInputSchema,
  output: AssessmentSchema,
});

export const resolveProject = defineRpc({
  name: "project.resolve",
  input: z.object({
    idempotencyKey: z.string().min(1).max(512),
    choiceId: z.enum(["current", "new"]),
    textValue: z.string().max(120).optional(),
    automatic: z.boolean(),
  }),
  output: z.object({ cwd: z.string(), projectId: z.string().optional() }).nullable(),
});

export interface ProjectDecision {
  choice: "current" | "new" | "uncertain";
  confidence: number;
  model?: string;
}

export type AssessmentInput = z.infer<typeof AssessmentInputSchema>;
export type Assessment = z.infer<typeof AssessmentSchema>;
