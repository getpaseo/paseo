import type { AgentInfo, ModelInfo, ModelRef, SessionInfo } from "@opencode/client";
import type { AgentMode, AgentModelDefinition, AgentUsage } from "../../../agent-sdk-types.js";

// Like v1 and OpenCode's web UI, Default omits `variant` and lets OpenCode resolve it.
const OPENCODE_DEFAULT_VARIANT_ID = "default";

export function modelRef(id: string, variant?: string | null): ModelRef {
  const slash = id.indexOf("/");
  if (slash < 1 || slash === id.length - 1)
    throw new Error("OpenCode model must be provider/model");
  return {
    providerID: id.slice(0, slash),
    id: id.slice(slash + 1),
    ...(variant && variant !== OPENCODE_DEFAULT_VARIANT_ID ? { variant } : {}),
  };
}

function thinkingOptionsFromV2(variants: ModelInfo["variants"]) {
  if (variants.length === 0) return undefined;
  return [
    { id: OPENCODE_DEFAULT_VARIANT_ID, label: "Default", isDefault: true },
    ...variants
      .filter((variant) => variant.id !== OPENCODE_DEFAULT_VARIANT_ID)
      .map((variant) => ({ id: variant.id, label: variant.id })),
  ];
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
      thinkingOptions: thinkingOptionsFromV2(model.variants),
      defaultThinkingOptionId: model.variants.length > 0 ? OPENCODE_DEFAULT_VARIANT_ID : undefined,
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
