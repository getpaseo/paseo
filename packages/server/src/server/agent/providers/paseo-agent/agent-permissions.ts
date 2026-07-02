import { z } from "zod";

const ToolPermissionActionSchema = z.enum(["allow", "deny"]);

export const ToolPermissionRuleSchema = z
  .object({
    tool: z.string().min(1),
    action: ToolPermissionActionSchema,
  })
  .strict();

export type ToolPermissionAction = z.infer<typeof ToolPermissionActionSchema>;
export type ToolPermissionRule = z.infer<typeof ToolPermissionRuleSchema>;

export interface CompiledToolPermissionRule {
  rule: ToolPermissionRule;
  matches(toolName: string): boolean;
}

export interface ToolPermissionPolicy {
  rules: ToolPermissionRule[];
  compiledRules: CompiledToolPermissionRule[];
}

export function createToolPermissionPolicy(
  rules: ToolPermissionRule[] | undefined,
): ToolPermissionPolicy {
  const normalizedRules = rules ?? [];
  return {
    rules: normalizedRules,
    compiledRules: normalizedRules.map((rule) => ({
      rule,
      matches: compileToolPattern(rule.tool),
    })),
  };
}

export function evaluateToolPermission(
  policy: ToolPermissionPolicy | undefined,
  toolName: string,
): ToolPermissionAction {
  for (const compiled of policy?.compiledRules ?? []) {
    if (compiled.matches(toolName)) {
      return compiled.rule.action;
    }
  }
  return "allow";
}

function compileToolPattern(pattern: string): (toolName: string) => boolean {
  if (pattern === "*") {
    return () => true;
  }
  if (!pattern.includes("*")) {
    return (toolName) => toolName === pattern;
  }
  const matcher = new RegExp(`^${wildcardPatternToRegExp(pattern)}$`);
  return (toolName) => matcher.test(toolName);
}

function wildcardPatternToRegExp(pattern: string): string {
  return pattern.split("*").map(escapeRegExp).join(".*");
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
