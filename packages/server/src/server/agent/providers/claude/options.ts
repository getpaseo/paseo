import type { ProviderOptions, ToolPolicy } from "@getpaseo/protocol/agent-types";
import { z } from "zod";

const PermissionRulesSchema = z
  .object({
    allow: z.array(z.string()).optional(),
    ask: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .strict();

const SandboxNetworkSchema = z
  .object({
    allowedDomains: z.array(z.string()).optional(),
    deniedDomains: z.array(z.string()).optional(),
    strictAllowlist: z.boolean().optional(),
    allowManagedDomainsOnly: z.boolean().optional(),
    allowUnixSockets: z.array(z.string()).optional(),
    allowAllUnixSockets: z.boolean().optional(),
    allowLocalBinding: z.boolean().optional(),
    allowMachLookup: z.array(z.string()).optional(),
    httpProxyPort: z.number().int().positive().optional(),
    socksProxyPort: z.number().int().positive().optional(),
    tlsTerminate: z
      .object({
        caCertPath: z.string().optional(),
        caKeyPath: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const SandboxFilesystemSchema = z
  .object({
    allowWrite: z.array(z.string()).optional(),
    denyWrite: z.array(z.string()).optional(),
    denyRead: z.array(z.string()).optional(),
    allowRead: z.array(z.string()).optional(),
    allowManagedReadPathsOnly: z.boolean().optional(),
    disabled: z.boolean().optional(),
  })
  .strict();

// Claude Agent SDK Options, maintained against @anthropic-ai/claude-agent-sdk 0.3.220.
export const ClaudeProviderOptionsSchema = z
  .object({
    allowedTools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    additionalDirectories: z.array(z.string()).optional(),
    // Native SDK skill context filter. `string[]` enables only the listed
    // skills (by SKILL.md name / dir, or `plugin:skill`); `"all"` enables every
    // discovered skill. Unlisted skills are hidden from the model's listing and
    // rejected by the Skill tool. Restrictive-only, so it fits the fail-closed
    // policy — flows through the `...providerOptions` spread in agent.ts.
    skills: z.union([z.array(z.string()), z.literal("all")]).optional(),
    sandbox: z
      .object({
        enabled: z.boolean().optional(),
        failIfUnavailable: z.boolean().optional(),
        autoAllowBashIfSandboxed: z.boolean().optional(),
        excludedCommands: z.array(z.string()).optional(),
        allowUnsandboxedCommands: z.boolean().optional(),
        network: SandboxNetworkSchema.optional(),
        filesystem: SandboxFilesystemSchema.optional(),
        ignoreViolations: z.record(z.string(), z.array(z.string())).optional(),
        enableWeakerNestedSandbox: z.boolean().optional(),
        ripgrep: z
          .object({ command: z.string(), args: z.array(z.string()).optional() })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    settings: z
      .object({
        permissions: PermissionRulesSchema.optional(),
        sandbox: z
          .object({
            enabled: z.boolean().optional(),
            failIfUnavailable: z.boolean().optional(),
            autoAllowBashIfSandboxed: z.boolean().optional(),
            excludedCommands: z.array(z.string()).optional(),
            allowUnsandboxedCommands: z.boolean().optional(),
            network: SandboxNetworkSchema.optional(),
            filesystem: SandboxFilesystemSchema.optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict() satisfies z.ZodType<ProviderOptions>;

export type ClaudeProviderOptions = z.infer<typeof ClaudeProviderOptionsSchema>;

export function applyClaudeToolPolicy(
  options: ClaudeProviderOptions,
  toolPolicy: ToolPolicy | undefined,
): ClaudeProviderOptions {
  if (!toolPolicy) return options;
  const allowedTools = Array.isArray(options.allowedTools)
    ? options.allowedTools.filter((tool): tool is string => typeof tool === "string")
    : [];
  const grants = toolPolicy.preapproved.map((grant) => `mcp__${grant.server}__${grant.tool}`);
  return { ...options, allowedTools: [...new Set([...allowedTools, ...grants])] };
}
