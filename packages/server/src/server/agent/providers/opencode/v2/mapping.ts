import type { AgentInfo, ModelInfo, ModelRef, SessionInfo } from "@opencode/client";
import type { AgentMode, AgentModelDefinition, AgentUsage } from "../../../agent-sdk-types.js";

export function modelRef(id: string, variant?: string | null): ModelRef {
  const slash = id.indexOf("/");
  if (slash < 1 || slash === id.length - 1)
    throw new Error("OpenCode model must be provider/model");
  return {
    providerID: id.slice(0, slash),
    id: id.slice(slash + 1),
    ...(variant ? { variant } : {}),
  };
}

// A model ref already names the provider that bills it, which is the id a usage source
// subscribes to. Aliases between the two namespaces would live in this table; a provider
// absent here has no login store Paseo can read, so its sessions report no plan.
const usageProviders: Record<string, string> = {
  "opencode-go": "opencode-go",
};

export function usageProvider(model: ModelRef): string | null {
  return usageProviders[model.providerID] ?? null;
}

export function modelsFromV2(models: ModelInfo[]): AgentModelDefinition[] {
  return models
    .filter((model) => model.enabled)
    .map((model) => ({
      provider: "opencode",
      id: `${model.providerID}/${model.id}`,
      label: model.name,
      contextWindowMaxTokens: model.limit.context,
      metadata: {
        providerId: model.providerID,
        modelId: model.id,
        supportsAttachments: model.capabilities.input.includes("image"),
        supportsToolCall: model.capabilities.tools,
        contextWindowMaxTokens: model.limit.context,
      },
      thinkingOptions: model.variants.map((variant) => ({ id: variant.id, label: variant.id })),
    }));
}

export function modesFromV2(agents: AgentInfo[]): AgentMode[] {
  return agents
    .filter((agent) => !agent.hidden && agent.mode !== "subagent")
    .map((agent) => ({ id: agent.id, label: agent.name, description: agent.description }));
}

export function usageFromV2(session: SessionInfo): AgentUsage {
  return {
    inputTokens: session.tokens.input,
    outputTokens: session.tokens.output,
    cachedInputTokens: session.tokens.cache.read,
    totalCostUsd: session.cost,
  };
}
