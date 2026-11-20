import { PluginOpenSupportSchema } from "@getpaseo/plugin/internal/lifecycle";
import type { PluginOpenSupport } from "@getpaseo/plugin/server";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";
import type { AgentClient, ResolveAgentOpenSupportInput } from "./agent-sdk-types.js";
import { isPaseoToolPolicyEnabled } from "./paseo-tool-policy.js";

export async function resolvePluginOpenSupport(input: {
  client: AgentClient;
  cwd: string;
  env?: Record<string, string>;
  opening?: Partial<ResolveAgentOpenSupportInput>;
  toolsEnabled: boolean;
  toolPolicy: ProviderPaseoToolsPolicy | undefined;
}): Promise<PluginOpenSupport | undefined> {
  const { client } = input;
  if (!client.adapter) return undefined;
  const opening = input.opening ?? {};
  const facts = (await client.resolveOpenSupport?.({
    config: opening.config ?? { provider: client.provider, cwd: input.cwd },
    env: input.env,
    persistence: opening.persistence,
    purpose: opening.purpose ?? "interactive",
    signal: opening.signal,
  })) ?? {
    instructions: "unknown",
    mcpHttp: client.capabilities.supportsMcpServers === false ? "unsupported" : "unknown",
    exactMcpPreapproval: "unknown",
    restrictions: { mcpConfiguration: "unknown", processEnvironment: "unknown" },
    providerOptions: [],
  };
  let delivery: PluginOpenSupport["attachedTools"]["delivery"] = "unknown";
  if (client.capabilities.supportsNativePaseoTools) delivery = "native";
  else if (facts.mcpHttp === "unsupported") delivery = "none";
  else if (facts.mcpHttp === "supported") delivery = "mcp";
  return PluginOpenSupportSchema.parse({
    ...facts,
    adapter: client.adapter,
    reasons: supportReasons(facts),
    attachedTools: {
      delivery,
      enabled: input.toolsEnabled && isPaseoToolPolicyEnabled(input.toolPolicy),
      disabledTools: input.toolPolicy?.disabledTools ?? [],
    },
  });
}

function supportReasons(
  facts: Pick<PluginOpenSupport, "instructions" | "mcpHttp" | "exactMcpPreapproval">,
): NonNullable<PluginOpenSupport["reasons"]> {
  const reasons: {
    -readonly [Key in keyof NonNullable<PluginOpenSupport["reasons"]>]: NonNullable<
      PluginOpenSupport["reasons"]
    >[Key];
  } = {};
  for (const key of ["instructions", "mcpHttp", "exactMcpPreapproval"] as const) {
    if (facts[key] === "unknown") reasons[key] = "not-established";
    else if (facts[key] === "unsupported") reasons[key] = "adapter-unsupported";
  }
  return reasons;
}
