import { z } from "zod";

export const SkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  source: z.enum(["builtin", "user", "marketplace"]),
  path: z.string().optional(),
  enabled: z.boolean(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Skill = z.infer<typeof SkillSchema>;

export const SkillCreateInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  content: z.string(),
  tags: z.array(z.string()).optional(),
});
export type SkillCreateInput = z.infer<typeof SkillCreateInputSchema>;

export const SkillUpdateInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  content: z.string().optional(),
  enabled: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
});
export type SkillUpdateInput = z.infer<typeof SkillUpdateInputSchema>;
