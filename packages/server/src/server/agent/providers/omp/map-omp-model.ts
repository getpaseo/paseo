import type {
  AgentModelDefinition,
  AgentProvider,
  AgentSelectOption,
} from "../../agent-sdk-types.js";
import type { OmpModel, OmpThinkingLevel } from "./rpc-types.js";

export const DEFAULT_OMP_THINKING_LEVEL: OmpThinkingLevel = "medium";

export const OMP_THINKING_OPTIONS: ReadonlyArray<{
  id: OmpThinkingLevel;
  label: string;
  description: string;
  isDefault?: boolean;
}> = [
  { id: "off", label: "Off", description: "No extra reasoning" },
  { id: "minimal", label: "Minimal", description: "Light reasoning" },
  { id: "low", label: "Low", description: "Faster reasoning" },
  { id: "medium", label: "Medium", description: "Balanced reasoning", isDefault: true },
  { id: "high", label: "High", description: "Deeper reasoning" },
  { id: "xhigh", label: "XHigh", description: "Extra-high reasoning" },
  { id: "max", label: "Max", description: "Maximum reasoning" },
] as const;

function mapThinkingOption(
  option: (typeof OMP_THINKING_OPTIONS)[number],
  isDefault?: boolean,
): AgentSelectOption {
  const mapped: AgentSelectOption = {
    id: option.id,
    label: option.label,
    description: option.description,
  };
  if (isDefault ?? option.isDefault) {
    mapped.isDefault = true;
  }
  return mapped;
}

export function mapOmpModel(model: OmpModel, provider: AgentProvider): AgentModelDefinition {
  const { thinkingOptions, defaultThinkingOptionId } = resolveOmpThinkingConfig(model);
  return {
    provider,
    id: `${model.provider}/${model.id}`,
    label: `${model.provider}/${model.name ?? model.id}`,
    description: `${model.provider}/${model.id}`,
    metadata: {
      provider: model.provider,
      modelId: model.id,
    },
    thinkingOptions,
    defaultThinkingOptionId,
  };
}

function resolveOmpThinkingConfig(model: OmpModel): {
  thinkingOptions: AgentSelectOption[] | undefined;
  defaultThinkingOptionId: string | undefined;
} {
  if (!model.reasoning) {
    return { thinkingOptions: undefined, defaultThinkingOptionId: undefined };
  }
  const efforts = model.thinking?.efforts;
  if (!efforts || efforts.length === 0) {
    // Older omp versions don't report per-model thinking config; expose the full set.
    return {
      thinkingOptions: OMP_THINKING_OPTIONS.map((option) => mapThinkingOption(option)),
      defaultThinkingOptionId: DEFAULT_OMP_THINKING_LEVEL,
    };
  }
  const effortSet = new Set(efforts);
  const filtered = OMP_THINKING_OPTIONS.filter((option) => effortSet.has(option.id));
  if (filtered.length === 0) {
    // All reported efforts are unrecognized; fall back to the full set with the standard default.
    return {
      thinkingOptions: OMP_THINKING_OPTIONS.map((option) => mapThinkingOption(option)),
      defaultThinkingOptionId: DEFAULT_OMP_THINKING_LEVEL,
    };
  }
  const reportedDefault = model.thinking?.defaultLevel;
  const defaultThinkingOptionId =
    reportedDefault && filtered.some((option) => option.id === reportedDefault)
      ? reportedDefault
      : (filtered[0]?.id ?? DEFAULT_OMP_THINKING_LEVEL);
  return {
    thinkingOptions: filtered.map((option) =>
      mapThinkingOption(option, option.id === defaultThinkingOptionId),
    ),
    defaultThinkingOptionId,
  };
}
