import type { AgentFeature, AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import { i18n } from "@/i18n/i18next";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import {
  AUTO_ACCEPT_FEATURE_ID,
  FAST_MODE_FEATURE_ID,
  PLAN_MODE_FEATURE_ID,
} from "@/agent-controls/policy";

export type ExplainedAgentControl = "mode" | "model" | "thinking";
export type FeatureHighlightColor = "blue" | "default" | "green" | "yellow";
export type AgentControlHintKey =
  | "agentControls.hints.thinking"
  | "agentControls.hints.model"
  | "agentControls.hints.mode";

export function getAgentControlHintKey(selector: ExplainedAgentControl): AgentControlHintKey {
  switch (selector) {
    case "thinking":
      return "agentControls.hints.thinking";
    case "model":
      return "agentControls.hints.model";
    case "mode":
      return "agentControls.hints.mode";
    default:
      throw new Error("unreachable");
  }
}

export function normalizeModelId(modelId: string | null | undefined): string | null {
  const normalized = typeof modelId === "string" ? modelId.trim() : "";
  if (!normalized) {
    return null;
  }
  return normalized;
}

export function getFeatureTooltip(
  feature: Pick<AgentFeature, "id" | "label" | "tooltip"> & { value?: unknown },
): string {
  if (feature.id === AUTO_ACCEPT_FEATURE_ID && typeof feature.value === "boolean") {
    return feature.value
      ? i18n.t("agentControls.features.autoAccept.tooltipOn")
      : i18n.t("agentControls.features.autoAccept.tooltipOff");
  }
  return feature.tooltip ?? feature.label;
}

export function getFeatureHighlightColor(featureId: string): FeatureHighlightColor {
  switch (featureId) {
    case FAST_MODE_FEATURE_ID:
      return "yellow";
    case AUTO_ACCEPT_FEATURE_ID:
      return "green";
    case PLAN_MODE_FEATURE_ID:
      return "blue";
    default:
      return "default";
  }
}

function findModelById(
  models: AgentModelDefinition[] | null,
  modelId: string | null,
): AgentModelDefinition | null {
  if (!models || !modelId) {
    return null;
  }
  return (
    models.find((model) => model.id === modelId) ??
    models.find((model) => model.aliases?.includes(modelId)) ??
    null
  );
}

function getFallbackModel(models: AgentModelDefinition[] | null): AgentModelDefinition | null {
  return models?.find((model) => model.isDefault) ?? models?.[0] ?? null;
}

function resolvePreferredModelId(
  runtimeSelectedModel: AgentModelDefinition | null,
  normalizedConfiguredModelId: string | null,
  normalizedRuntimeModelId: string | null,
): string | null {
  return runtimeSelectedModel?.id ?? normalizedConfiguredModelId ?? normalizedRuntimeModelId;
}

function pickSelectedModel(
  models: AgentModelDefinition[] | null,
  preferredModelId: string | null,
  fallbackModel: AgentModelDefinition | null,
): AgentModelDefinition | null {
  if (!models || !preferredModelId) {
    return fallbackModel;
  }
  return findModelById(models, preferredModelId) ?? fallbackModel;
}

function resolveThinkingId(
  explicitThinkingOptionId: string | null | undefined,
  selectedModel: AgentModelDefinition | null,
): string | null {
  if (explicitThinkingOptionId && explicitThinkingOptionId !== "default") {
    return explicitThinkingOptionId;
  }
  return selectedModel?.defaultThinkingOptionId ?? null;
}

type ThinkingOption = NonNullable<AgentModelDefinition["thinkingOptions"]>[number];

function resolveEffectiveThinking(
  thinkingOptions: ThinkingOption[] | null,
  resolvedThinkingId: string | null,
): ThinkingOption | null {
  const selectedThinking =
    thinkingOptions?.find((option) => option.id === resolvedThinkingId) ?? null;
  return selectedThinking ?? thinkingOptions?.[0] ?? null;
}

function resolveModelDisplay(
  selectedModel: AgentModelDefinition | null,
  preferredModelId: string | null,
  fallbackModel: AgentModelDefinition | null,
  unknownModelLabel: string,
): { activeModelId: string | null; displayModel: string } {
  return {
    activeModelId: selectedModel?.id ?? preferredModelId ?? null,
    displayModel:
      selectedModel?.label ?? preferredModelId ?? fallbackModel?.label ?? unknownModelLabel,
  };
}

function resolveThinkingDisplay(
  effectiveThinking: ThinkingOption | null,
  selectedThinkingId: string | null,
  unknownThinkingLabel: string,
): string {
  if (effectiveThinking) {
    return formatThinkingOptionLabel(effectiveThinking);
  }

  if (selectedThinkingId) {
    return formatThinkingOptionLabel({ id: selectedThinkingId });
  }

  return unknownThinkingLabel;
}

export function resolveAgentModelSelection(input: {
  models: AgentModelDefinition[] | null;
  runtimeModelId: string | null | undefined;
  configuredModelId: string | null | undefined;
  explicitThinkingOptionId: string | null | undefined;
}) {
  const { models, runtimeModelId, configuredModelId, explicitThinkingOptionId } = input;
  const normalizedRuntimeModelId = normalizeModelId(runtimeModelId);
  const normalizedConfiguredModelId = normalizeModelId(configuredModelId);

  const runtimeSelectedModel = findModelById(models, normalizedRuntimeModelId);
  const preferredModelId = resolvePreferredModelId(
    runtimeSelectedModel,
    normalizedConfiguredModelId,
    normalizedRuntimeModelId,
  );
  const fallbackModel = getFallbackModel(models);
  const selectedModel = pickSelectedModel(models, preferredModelId, fallbackModel);

  const { activeModelId, displayModel } = resolveModelDisplay(
    selectedModel,
    preferredModelId,
    fallbackModel,
    i18n.t("agentControls.model.unknown"),
  );

  const thinkingOptions = selectedModel?.thinkingOptions ?? null;
  const resolvedThinkingId = resolveThinkingId(explicitThinkingOptionId, selectedModel);
  const effectiveThinking = resolveEffectiveThinking(thinkingOptions, resolvedThinkingId);
  const selectedThinkingId = effectiveThinking?.id ?? null;
  const displayThinking = resolveThinkingDisplay(
    effectiveThinking,
    selectedThinkingId,
    i18n.t("agentControls.thinking.unknown"),
  );

  return {
    selectedModel,
    activeModelId,
    displayModel,
    thinkingOptions,
    selectedThinkingId,
    displayThinking,
  };
}
