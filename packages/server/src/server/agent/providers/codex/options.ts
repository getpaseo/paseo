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
    // Composer controls, not Codex config: the provider reads them and keeps them out of `config`.
    service_tier: z.string().optional(),
    plan_mode: z.boolean().optional(),
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

const MCP_SERVERS_PREFIX = "mcp_servers.";

function buildCodexToolApprovals(tools: string[]): Record<string, { approval_mode: "approve" }> {
  return Object.fromEntries(tools.map((tool) => [tool, { approval_mode: "approve" }]));
}

function withCodexToolApprovals(
  serverConfig: Record<string, unknown>,
  tools: string[],
): Record<string, unknown> {
  return {
    ...serverConfig,
    enabled_tools: tools,
    default_tools_approval_mode: "prompt",
    tools: buildCodexToolApprovals(tools),
  };
}

export function applyCodexToolPolicy(
  config: Record<string, unknown>,
  toolPolicy: ToolPolicy | undefined,
): Record<string, unknown> {
  if (!toolPolicy || toolPolicy.preapproved.length === 0) return config;

  const grantsByServer = new Map<string, string[]>();
  for (const grant of toolPolicy.preapproved) {
    const tools = grantsByServer.get(grant.server) ?? [];
    tools.push(grant.tool);
    grantsByServer.set(grant.server, tools);
  }

  // Codex's `apply_toml_override` splits dotted paths on `.`, so a server name
  // containing `.` cannot be addressed as `mcp_servers.<name>`. Keep all MCP
  // entries in one `mcp_servers` table in that case so Codex's unordered config
  // map cannot apply a whole-table override after a dotted one.
  const hasWholeTable = "mcp_servers" in config;
  const hasDottedGrantName = [...grantsByServer.keys()].some((server) => server.includes("."));
  if (hasWholeTable || hasDottedGrantName) {
    const next: Record<string, unknown> = {};
    const mcpServers = readRecord(config.mcp_servers);
    for (const [key, value] of Object.entries(config)) {
      if (key === "mcp_servers") continue;
      if (key.startsWith(MCP_SERVERS_PREFIX)) {
        mcpServers[key.slice(MCP_SERVERS_PREFIX.length)] = value;
      } else {
        next[key] = value;
      }
    }
    for (const [server, tools] of grantsByServer) {
      mcpServers[server] = withCodexToolApprovals(readRecord(mcpServers[server]), tools);
    }
    next.mcp_servers = mcpServers;
    return next;
  }

  const next: Record<string, unknown> = { ...config };
  for (const [server, tools] of grantsByServer) {
    const key = `${MCP_SERVERS_PREFIX}${server}`;
    if (key in next) {
      next[key] = withCodexToolApprovals(readRecord(next[key]), tools);
    } else {
      next[`${key}.enabled_tools`] = tools;
      next[`${key}.default_tools_approval_mode`] = "prompt";
      next[`${key}.tools`] = buildCodexToolApprovals(tools);
    }
  }
  return next;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}
