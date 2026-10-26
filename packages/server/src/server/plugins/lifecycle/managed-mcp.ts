import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
  PluginBeforeRequests,
  PluginMcpBindRequest,
  PluginMcpBinding,
  PluginSessionOpenRequest,
} from "@getpaseo/plugin/server";
import type { AgentSessionConfig, McpServerConfig } from "../../agent/agent-sdk-types.js";
import type { ToolPolicy } from "@getpaseo/protocol/agent-types";

export const MANAGED_MCP_INERT_AUTHORIZATION = "PASEO_MANAGED_MCP_INERT";
export const managedMcpDeclarationSchema = z
  .object({
    bindPluginId: z.string().min(1),
    bootstrapEnvKeys: z.array(z.string().regex(/^PASEO_[A-Z0-9_]+_BOOTSTRAP_REF$/)).optional(),
    ownerPluginId: z.string().min(1).optional(),
  })
  .strict();
export const mcpBindingSchema = z
  .object({
    openingId: z.string().uuid(),
    sessionEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    bindRequestId: z.string().min(1),
  })
  .strict();
export type ManagedMcpServers = Record<
  string,
  {
    ownerPluginId: string;
    bindPluginId: string;
    server: McpServerConfig;
    toolPolicy?: ToolPolicy;
    bootstrapEnvKeys?: string[];
  }
>;

export const managedMcpContextSchema = z
  .object({
    opening: z
      .object({ id: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict(),
    servers: z.array(
      z
        .object({
          name: z.string(),
          url: z.string(),
          ownerPluginId: z.string(),
          bindPluginId: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

function requireInertHttpServer(name: string, server: McpServerConfig | undefined): void {
  if (!server || server.type !== "http" || name === "paseo") {
    throw new Error("Managed MCP authorization requires a contributed HTTP server");
  }
  const url = new URL(server.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    decodeURIComponent(url.pathname).toLowerCase().replace(/\/+$/, "") === "/mcp/agents" ||
    url.href !== server.url
  ) {
    throw new Error("Managed MCP server URL must be canonical and cannot target daemon tools");
  }
  if (!isDeepStrictEqual(server.headers, { Authorization: MANAGED_MCP_INERT_AUTHORIZATION })) {
    throw new Error("Managed MCP servers must declare only the inert Authorization placeholder");
  }
}

/** Called only at the authenticated subprocess contribution boundary. */
export function attestManagedMcpContribution(
  previous: PluginBeforeRequests["agent.create"],
  next: PluginBeforeRequests["agent.create"],
  pluginId: string,
): void {
  for (const [name, declaration] of Object.entries(previous.managedMcpServers ?? {})) {
    if (
      !isDeepStrictEqual(next.managedMcpServers?.[name], declaration) ||
      !isDeepStrictEqual(next.config.mcpServers?.[name], previous.config.mcpServers?.[name]) ||
      !isDeepStrictEqual(next.config.toolPolicy, previous.config.toolPolicy)
    ) {
      throw new Error("Conflicting managed MCP contribution");
    }
  }
  for (const [name, declaration] of Object.entries(next.managedMcpServers ?? {})) {
    if (previous.managedMcpServers?.[name]) continue;
    if (previous.config.mcpServers?.[name] || declaration.ownerPluginId) {
      throw new Error("Managed MCP ownership requires a newly contributed server");
    }
    requireInertHttpServer(name, next.config.mcpServers?.[name]);
    declaration.ownerPluginId = pluginId;
  }
}

export function captureManagedMcpServers(
  request: PluginBeforeRequests["agent.create"],
): ManagedMcpServers | undefined {
  if (!request.managedMcpServers || !Object.keys(request.managedMcpServers).length) return;
  const servers: ManagedMcpServers = {};
  for (const [name, declaration] of Object.entries(request.managedMcpServers)) {
    if (!declaration.ownerPluginId) throw new Error("Missing host-attested MCP owner");
    requireInertHttpServer(name, request.config.mcpServers?.[name]);
    servers[name] = {
      ...declaration,
      ownerPluginId: declaration.ownerPluginId,
      server: structuredClone(request.config.mcpServers![name]!),
      toolPolicy: structuredClone(request.config.toolPolicy),
    };
  }
  return servers;
}

export function validateManagedMcpConfig(config: AgentSessionConfig): void {
  if (config.internal && config.managedMcpServers) {
    throw new Error("Internal agents cannot declare managed MCP authorization");
  }
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    if (
      server.type === "http" &&
      server.headers?.Authorization === MANAGED_MCP_INERT_AUTHORIZATION &&
      !config.managedMcpServers?.[name]
    ) {
      throw new Error(
        "Managed MCP placeholder has no host-attested owner; start a fresh execution",
      );
    }
  }
  for (const [name, owned] of Object.entries(config.managedMcpServers ?? {})) {
    requireInertHttpServer(name, config.mcpServers?.[name]);
    if (
      !isDeepStrictEqual(config.mcpServers?.[name], owned.server) ||
      !isDeepStrictEqual(config.toolPolicy, owned.toolPolicy)
    ) {
      throw new Error("Managed MCP configuration changed; start a fresh execution");
    }
  }
}

export function createMcpOpening(
  config: AgentSessionConfig,
  session: PluginSessionOpenRequest,
): PluginMcpBindRequest["opening"] {
  return {
    id: randomUUID(),
    digest: createHash("sha256")
      .update(
        JSON.stringify(
          {
            agentId: session.agentId,
            workspaceId: session.workspaceId,
            provider: session.provider,
            cwd: session.cwd,
            reason: session.reason,
            purpose: session.purpose,
            config,
            env: session.env,
          },
          (_key, value: unknown) => {
            if (value && typeof value === "object" && !Array.isArray(value)) {
              return Object.fromEntries(
                Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
              );
            }
            return value;
          },
        ),
      )
      .digest("hex"),
  };
}

export function requireMcpBinding(session: PluginMcpBindRequest): PluginMcpBinding {
  const binding = session.binding;
  if (!session.opening || !binding || binding.openingId !== session.opening.id) {
    throw new Error(
      "Required managed MCP bind gate did not authorize this opening; start a fresh execution",
    );
  }
  return binding;
}

export function validateManagedHookResult(
  name: "agent.mcp_bind" | "agent.mcp_authorization",
  input: PluginBeforeRequests[keyof PluginBeforeRequests],
  result: PluginBeforeRequests[keyof PluginBeforeRequests],
): void {
  const editable = name === "agent.mcp_bind" ? "binding" : "authorization";
  const previous = { ...input } as Record<string, unknown>;
  const next = { ...result } as Record<string, unknown>;
  delete previous[editable];
  delete next[editable];
  if (name === "agent.mcp_bind") {
    const oldRequest = input as PluginMcpBindRequest;
    const newRequest = result as PluginMcpBindRequest;
    for (const [key, value] of Object.entries(newRequest.env)) {
      if (oldRequest.env[key] !== value)
        throw new Error("Managed MCP bind may only remove environment overrides");
    }
    for (const key of Object.keys(oldRequest.env)) {
      if (!(key in newRequest.env) && !oldRequest.bootstrapEnvKeys.includes(key)) {
        throw new Error("Managed MCP bind cannot remove unrelated environment overrides");
      }
    }
    delete previous.env;
    delete next.env;
  }
  if (!isDeepStrictEqual(previous, next)) {
    throw new Error("Managed MCP hooks cannot change opening identity, binding, or server");
  }
  if (
    name === "agent.mcp_bind" &&
    "binding" in input &&
    input.binding !== undefined &&
    !isDeepStrictEqual(input, result)
  ) {
    throw new Error("Managed MCP binding conflict");
  }
  if (
    name === "agent.mcp_authorization" &&
    "authorization" in input &&
    input.authorization !== undefined &&
    !isDeepStrictEqual(input, result)
  ) {
    throw new Error("Conflicting managed MCP authorization");
  }
}
