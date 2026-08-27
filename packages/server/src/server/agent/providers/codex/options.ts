import type { ProviderOptions, ToolPolicy } from "@getpaseo/protocol/agent-types";
import { z } from "zod";

const ApprovalPolicySchema = z.union([
  z.enum(["untrusted", "on-request", "never"]),
  z
    .object({
      granular: z
        .object({
          sandbox_approval: z.boolean().optional(),
          rules: z.boolean().optional(),
          mcp_elicitations: z.boolean().optional(),
          request_permissions: z.boolean().optional(),
          skill_approval: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
]);

const NetworkPolicySchema = z
  .object({
    enabled: z.boolean().optional(),
    proxy_url: z.string().optional(),
    socks_url: z.string().optional(),
    enable_socks5: z.boolean().optional(),
    enable_socks5_udp: z.boolean().optional(),
    allow_local_binding: z.boolean().optional(),
    allow_upstream_proxy: z.boolean().optional(),
    dangerously_allow_all_unix_sockets: z.boolean().optional(),
    dangerously_allow_non_loopback_proxy: z.boolean().optional(),
    domains: z.record(z.string(), z.enum(["allow", "deny"])).optional(),
    unix_sockets: z.record(z.string(), z.enum(["allow", "deny"])).optional(),
  })
  .strict();

// Codex config reference, maintained against Codex CLI 0.143+.
export const CodexProviderOptionsSchema = z
  .object({
    approval_policy: ApprovalPolicySchema.optional(),
    sandbox_mode: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
    sandbox_workspace_write: z
      .object({
        writable_roots: z.array(z.string()).optional(),
        network_access: z.boolean().optional(),
        exclude_slash_tmp: z.boolean().optional(),
        exclude_tmpdir_env_var: z.boolean().optional(),
      })
      .strict()
      .optional(),
    web_search: z.enum(["disabled", "cached", "indexed", "live"]).optional(),
    features: z
      .object({
        network_proxy: z.union([z.boolean(), NetworkPolicySchema]).optional(),
        multi_agent_v2: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict() satisfies z.ZodType<ProviderOptions>;

export type CodexProviderOptions = z.infer<typeof CodexProviderOptionsSchema>;

export function applyCodexToolPolicy(
  config: Record<string, unknown>,
  toolPolicy: ToolPolicy | undefined,
): Record<string, unknown> {
  if (!toolPolicy) return config;
  const mcpServers = readRecord(config.mcp_servers);
  const grantsByServer = new Map<string, string[]>();
  for (const grant of toolPolicy.preapproved) {
    const tools = grantsByServer.get(grant.server) ?? [];
    tools.push(grant.tool);
    grantsByServer.set(grant.server, tools);
  }
  for (const [server, tools] of grantsByServer) {
    const serverConfig = readRecord(mcpServers[server]);
    const approvals = Object.fromEntries(tools.map((tool) => [tool, { approval_mode: "approve" }]));
    mcpServers[server] = {
      ...serverConfig,
      enabled_tools: tools,
      default_tools_approval_mode: "prompt",
      tools: approvals,
    };
  }
  return { ...config, mcp_servers: mcpServers };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}
