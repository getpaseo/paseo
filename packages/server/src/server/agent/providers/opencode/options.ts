import type { ProviderOptions, ToolPolicy } from "@getpaseo/protocol/agent-types";
import { z } from "zod";

const PermissionActionSchema = z.enum(["ask", "allow", "deny"]);
const PermissionRuleSchema = z.union([
  PermissionActionSchema,
  z.record(z.string(), PermissionActionSchema),
]);

// OpenCode Config.permission, maintained against @opencode-ai/sdk 1.18.18.
export const OpenCodeProviderOptionsSchema = z
  .object({
    permission: z
      .union([
        PermissionActionSchema,
        z
          .object({
            read: PermissionRuleSchema.optional(),
            edit: PermissionRuleSchema.optional(),
            glob: PermissionRuleSchema.optional(),
            grep: PermissionRuleSchema.optional(),
            list: PermissionRuleSchema.optional(),
            bash: PermissionRuleSchema.optional(),
            task: PermissionRuleSchema.optional(),
            external_directory: PermissionRuleSchema.optional(),
            todowrite: PermissionActionSchema.optional(),
            question: PermissionActionSchema.optional(),
            webfetch: PermissionActionSchema.optional(),
            websearch: PermissionActionSchema.optional(),
            codesearch: PermissionActionSchema.optional(),
            repo_clone: PermissionRuleSchema.optional(),
            repo_overview: PermissionRuleSchema.optional(),
            lsp: PermissionRuleSchema.optional(),
            doom_loop: PermissionActionSchema.optional(),
            skill: PermissionRuleSchema.optional(),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict() satisfies z.ZodType<ProviderOptions>;

export type OpenCodeProviderOptions = z.infer<typeof OpenCodeProviderOptionsSchema>;

export interface OpenCodePermissionRule {
  permission: string;
  pattern: string;
  action: "ask" | "allow" | "deny";
}

export function buildOpenCodePermissionRules(
  options: OpenCodeProviderOptions | undefined,
  toolPolicy: ToolPolicy | undefined,
): OpenCodePermissionRule[] | undefined {
  const grants =
    toolPolicy?.preapproved.map((grant) => ({
      permission: `${grant.server}_${grant.tool}`,
      pattern: "*",
      action: "allow" as const,
    })) ?? [];
  const permission = options?.permission;
  if (typeof permission === "string") {
    return [...grants, { permission: "*", pattern: "*", action: permission }];
  }
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) {
    return grants.length > 0 ? grants : undefined;
  }
  const authored = Object.entries(permission).flatMap(([name, rule]) => {
    if (typeof rule === "string") {
      return [{ permission: name, pattern: "*", action: rule }];
    }
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return [];
    return Object.entries(rule).flatMap(([pattern, action]) =>
      typeof action === "string" ? [{ permission: name, pattern, action }] : [],
    );
  });
  return [...grants, ...authored];
}
