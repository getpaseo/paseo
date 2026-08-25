import type { ProviderOptions, ToolPolicy } from "@getpaseo/protocol/agent-types";
import { z } from "zod";

const PermissionActionSchema = z.enum(["ask", "allow", "deny"]);
const PermissionRuleSchema = z.union([
  PermissionActionSchema,
  z.record(z.string(), PermissionActionSchema),
]);

// OpenCode v2 Config.permission, maintained against @opencode-ai/client 0.0.0-beta-18155.
// v2 action names differ from v1: shell/edit/read/grep/glob/webfetch/websearch/subagent/
// external_directory plus the "*" catch-all. v2 has no bash/list/task/todowrite/question
// actions (those are v1 concepts).
export const OpenCodeV2ProviderOptionsSchema = z
  .object({
    permission: z
      .union([
        PermissionActionSchema,
        z
          .object({
            shell: PermissionRuleSchema.optional(),
            edit: PermissionRuleSchema.optional(),
            read: PermissionRuleSchema.optional(),
            grep: PermissionRuleSchema.optional(),
            glob: PermissionRuleSchema.optional(),
            webfetch: PermissionRuleSchema.optional(),
            websearch: PermissionRuleSchema.optional(),
            subagent: PermissionRuleSchema.optional(),
            external_directory: PermissionRuleSchema.optional(),
            "*": PermissionRuleSchema.optional(),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict() satisfies z.ZodType<ProviderOptions>;

export type OpenCodeV2ProviderOptions = z.infer<typeof OpenCodeV2ProviderOptionsSchema>;

export interface OpenCodeV2PermissionRule {
  action: string;
  resource: string;
  effect: "ask" | "allow" | "deny";
}

/**
 * Sanitize an MCP server/tool name into the v2 permission action namespace.
 * v2 registers MCP tools under `McpTool.name(server, tool)`:
 * `${server.replace(/[^a-zA-Z0-9_-]/g, "_")}_${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`.
 * A preapproval grant must use the same composite action to match.
 */
function toOpenCodeV2McpAction(server: string, tool: string): string {
  const namespace = server.replace(/[^a-zA-Z0-9_-]/g, "_");
  const toolName = tool.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${namespace}_${toolName}`;
}

/**
 * Default v2 permission rules applied to every opencode-v2 agent. The v2
 * built-in `build` agent allows `*:*` by default, so without an override no
 * tool ever prompts. Paseo's convention (and the validation contract) is
 * ask-by-default: sensitive native actions prompt, safe read-only actions run,
 * and MCP tools fall through to the build agent's allow so injected MCP servers
 * keep working (VAL-OC2-MCP-001). Rules are written to the isolated opencode2
 * config and appended after the built-in agent rules, so they take precedence
 * (v2 evaluates rules with findLast).
 */
const OPENCODE_V2_DEFAULT_PERMISSION_RULES: OpenCodeV2PermissionRule[] = [
  // Safe read-only actions run without prompting.
  { action: "read", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "subagent", resource: "*", effect: "allow" },
  { action: "question", resource: "*", effect: "allow" },
  // Sensitive native actions prompt by default.
  { action: "shell", resource: "*", effect: "ask" },
  { action: "edit", resource: "*", effect: "ask" },
  { action: "webfetch", resource: "*", effect: "ask" },
  { action: "websearch", resource: "*", effect: "ask" },
  { action: "external_directory", resource: "*", effect: "ask" },
];

/**
 * Base rules used when an exact-MCP preapproval tool policy is present. Exact
 * preapproval means "everything prompts except the preapproved grants", so the
 * catch-all is `ask` (non-preapproved MCP tools and native tools prompt) while
 * safe read-only actions still run (VAL-OC2-PERM-016).
 */
const OPENCODE_V2_TOOL_POLICY_PERMISSION_RULES: OpenCodeV2PermissionRule[] = [
  { action: "*", resource: "*", effect: "ask" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "subagent", resource: "*", effect: "allow" },
  { action: "question", resource: "*", effect: "allow" },
];

/**
 * Map paseo's `permission` provider option (ask/allow/deny or per-tool rules)
 * plus `toolPolicy.preapproved` exact MCP grants into v2 permission rules.
 *
 * v2 has no per-prompt permission field (unlike v1): permissions are per-agent
 * config. The returned rules are written to the isolated opencode2 config's
 * `permissions` array (see permission-config.ts), which the `opencode.config.agent`
 * plugin appends to every agent. Rules are ordered so later entries win
 * (v2 `Permission.evaluate` uses findLast).
 */
export function buildOpenCodeV2PermissionRules(
  options: OpenCodeV2ProviderOptions | undefined,
  toolPolicy: ToolPolicy | undefined,
): OpenCodeV2PermissionRule[] | undefined {
  const grants =
    toolPolicy?.preapproved.map((grant) => ({
      action: toOpenCodeV2McpAction(grant.server, grant.tool),
      resource: "*",
      effect: "allow" as const,
    })) ?? [];
  const base =
    grants.length > 0
      ? OPENCODE_V2_TOOL_POLICY_PERMISSION_RULES
      : OPENCODE_V2_DEFAULT_PERMISSION_RULES;
  const permission = options?.permission;
  if (typeof permission === "string") {
    return [...base, ...grants, { action: "*", resource: "*", effect: permission }];
  }
  if (permission && typeof permission === "object" && !Array.isArray(permission)) {
    const authored = Object.entries(permission).flatMap(([name, rule]) => {
      if (typeof rule === "string") {
        return [{ action: name, resource: "*", effect: rule }];
      }
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) return [];
      return Object.entries(rule).flatMap(([pattern, action]) =>
        typeof action === "string" ? [{ action: name, resource: pattern, effect: action }] : [],
      );
    });
    return [...base, ...grants, ...authored];
  }
  return [...base, ...grants];
}
