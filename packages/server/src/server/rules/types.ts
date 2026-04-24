import { z } from "zod";

/**
 * A Hubcode rule — a short, always-follow instruction injected into every
 * supported CLI and GUI agent via a managed section inside their canonical
 * guidelines file (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, …). Users see
 * the same UX as commands: scope selector, toggle, custom authoring.
 */

export const RuleScopeSchema = z.enum(["global", "project"]);
export type RuleScope = z.infer<typeof RuleScopeSchema>;

export const HubcodeRuleSchema = z.object({
  id: z.string().min(1),
  /** Short, human-readable title — shown in Settings and as the rule heading. */
  title: z.string().min(1).max(120),
  description: z.string().optional(),
  /** Markdown body that gets injected into each agent's rules file. */
  body: z.string().min(1),
  author: z.union([z.literal("builtin"), z.string()]),
  scope: RuleScopeSchema,
  projectPaths: z.array(z.string()).optional(),
  /** Subset of agent IDs to target. Empty/undefined = all. */
  targetAgents: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});

export type HubcodeRule = z.infer<typeof HubcodeRuleSchema>;

export interface RuleInstallStatus {
  agentId: string;
  agentActive: boolean;
  status: "installed" | "not-installed" | "unsupported" | "disabled" | "error";
  reason?: string;
}

export interface RuleRuntimeState {
  enabled: boolean;
  installStatus?: RuleInstallStatus[];
}

export interface RuleWithState {
  definition: HubcodeRule;
  state: RuleRuntimeState;
}
