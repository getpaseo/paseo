import type {
  AgentModelDefinition,
  AgentProvider,
  AgentSelectOption,
} from "../../agent-sdk-types.js";
import { modelDisplayLabel } from "../model-label.js";
import type { OmpModel, OmpThinkingLevel } from "./rpc-types.js";

// What OMP runs at when a launch passes no --thinking and the model reports no
// defaultLevel of its own.
export const DEFAULT_OMP_THINKING_LEVEL: OmpThinkingLevel = "high";

export const OMP_THINKING_OPTIONS: ReadonlyArray<{
  id: OmpThinkingLevel;
  label: string;
  description: string;
  isDefault?: boolean;
}> = [
  { id: "auto", label: "Auto", description: "OMP picks the effort each turn" },
  { id: "off", label: "Off", description: "No extra reasoning" },
  { id: "minimal", label: "Minimal", description: "Light reasoning" },
  { id: "low", label: "Low", description: "Faster reasoning" },
  { id: "medium", label: "Medium", description: "Balanced reasoning" },
  { id: "high", label: "High", description: "Deeper reasoning", isDefault: true },
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
    label: modelDisplayLabel(model),
    description: `${model.provider}/${model.id}`,
    metadata: {
      provider: model.provider,
      modelId: model.id,
    },
    thinkingOptions,
    defaultThinkingOptionId,
  };
}

type OmpThinkingOption = (typeof OMP_THINKING_OPTIONS)[number];

function isPerModelThinkingLevel(value: string): value is OmpThinkingLevel {
  return value !== "auto" && OMP_THINKING_OPTIONS.some((option) => option.id === value);
}

function thinkingRank(level: OmpThinkingLevel): number {
  return OMP_THINKING_OPTIONS.findIndex((option) => option.id === level);
}

// OMP clamps a requested level to the closest effort the model reports, and the
// lower effort wins a tie: "high" runs as "medium" on a [low, medium, xhigh] model.
function clampThinkingLevel(
  level: OmpThinkingLevel,
  options: readonly OmpThinkingOption[],
): OmpThinkingLevel | undefined {
  const target = thinkingRank(level);
  let best: OmpThinkingLevel | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const option of options) {
    const distance = Math.abs(thinkingRank(option.id) - target);
    if (distance < bestDistance) {
      best = option.id;
      bestDistance = distance;
    }
  }
  return best;
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
  // `auto` is a session-level OMP mode, never a per-model effort, so models do not list it.
  const filtered = OMP_THINKING_OPTIONS.filter(
    (option) => option.id !== "auto" && effortSet.has(option.id),
  );
  if (filtered.length === 0) {
    // All reported efforts are unrecognized; fall back to the full set with the standard default.
    return {
      thinkingOptions: OMP_THINKING_OPTIONS.map((option) => mapThinkingOption(option)),
      defaultThinkingOptionId: DEFAULT_OMP_THINKING_LEVEL,
    };
  }
  const reportedDefault = model.thinking?.defaultLevel;
  const preferredDefault =
    reportedDefault && isPerModelThinkingLevel(reportedDefault)
      ? reportedDefault
      : DEFAULT_OMP_THINKING_LEVEL;
  const defaultThinkingOptionId =
    clampThinkingLevel(preferredDefault, filtered) ?? DEFAULT_OMP_THINKING_LEVEL;
  const options = [OMP_THINKING_OPTIONS[0], ...filtered];
  return {
    thinkingOptions: options.map((option) =>
      mapThinkingOption(option, option.id === defaultThinkingOptionId),
    ),
    defaultThinkingOptionId,
  };
}
