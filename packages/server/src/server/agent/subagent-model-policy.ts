import type { AgentModelDefinition, AgentProvider } from "./agent-sdk-types.js";

export interface SubagentModelPolicyConfig {
  subagentAllowedModels?: string[];
  subagentModelGuidance?: Record<string, string>;
}

export interface GuidedAgentModelDefinition extends AgentModelDefinition {
  whenToUse?: string;
}

export interface AgentOrchestrationOrigin {
  agentId: string;
}

export function readSubagentModelPolicy(value: unknown): SubagentModelPolicyConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const config = value as SubagentModelPolicyConfig;
  return Array.isArray(config.subagentAllowedModels) || config.subagentModelGuidance !== undefined
    ? config
    : undefined;
}

function allowedModelIds(provider: AgentProvider, policy: SubagentModelPolicyConfig): Set<string> {
  return new Set(
    policy.subagentAllowedModels?.flatMap((value) => {
      const trimmed = value.trim();
      if (!trimmed) return [];
      const providerPrefix = `${provider}/`;
      if (trimmed.startsWith(providerPrefix) && trimmed.length > providerPrefix.length) {
        return [trimmed, trimmed.slice(providerPrefix.length)];
      }
      return [trimmed];
    }) ?? [],
  );
}

export function projectSubagentModels(params: {
  provider: AgentProvider;
  models: AgentModelDefinition[];
  policy: SubagentModelPolicyConfig | undefined;
}): GuidedAgentModelDefinition[] {
  if (!params.policy) return params.models;
  const policy = params.policy;
  const allowed = allowedModelIds(params.provider, policy);
  const isRestricted = (policy.subagentAllowedModels?.length ?? 0) > 0;
  return params.models.flatMap((model) => {
    if (isRestricted && !allowed.has(model.id)) return [];
    const whenToUse = policy.subagentModelGuidance?.[model.id]?.trim();
    return [{ ...model, ...(whenToUse ? { whenToUse } : {}) }];
  });
}

export function resolveSubagentModel(params: {
  provider: AgentProvider;
  requestedModel: string | undefined;
  models: AgentModelDefinition[];
  policy: SubagentModelPolicyConfig | undefined;
}): string | undefined {
  if (!params.policy) return undefined;
  if ((params.policy.subagentAllowedModels?.length ?? 0) === 0) {
    return params.requestedModel?.trim() || undefined;
  }
  const requested = params.requestedModel?.trim();
  const model = requested
    ? params.models.find((candidate) => candidate.id === requested)
    : (params.models.find((candidate) => candidate.isDefault) ?? params.models[0]);
  const display = `${params.provider}/${requested ?? model?.id ?? "default"}`;
  if (!model) throw new Error(`Model '${display}' is not currently available`);
  if (!allowedModelIds(params.provider, params.policy).has(model.id)) {
    throw new Error(`Model '${params.provider}/${model.id}' is not allowed for agent-created work`);
  }
  return model.id;
}
