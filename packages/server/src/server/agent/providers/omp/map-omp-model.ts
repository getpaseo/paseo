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
  { id: "auto", label: "Auto", description: "OMP picks the effort each turn" },
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

// Drops an upstream "Vendor: " prefix ("OpenAI: GPT-5.5"). A colon inside parentheses or after a
// comma belongs to the model name ("DeepSeek V4 (ctx: 128k)"), so it is kept.
function stripVendorPrefix(label: string): string {
  const vendorSeparatorIndex = label.indexOf(": ");
  if (vendorSeparatorIndex === -1 || /[(),]/.test(label.slice(0, vendorSeparatorIndex))) {
    return label;
  }
  return label.slice(vendorSeparatorIndex + 2).trim();
}

// An OMP model name is either a path ("google/gemini_2.5-flash", as OpenRouter reports it) or
// free text that can contain slashes and underscores ("IQ3_S ... 52/56"). Only shorten paths.
function ompModelLabel(model: Pick<OmpModel, "id" | "name">): string {
  const text = model.name?.trim().replace(/\s+/g, " ") || model.id.trim();
  if (/\s/.test(text)) {
    return stripVendorPrefix(text);
  }
  const lastSegment = text.split("/").findLast((segment) => segment.length > 0) ?? text;
  return stripVendorPrefix(lastSegment.replace(/_+/g, " "));
}

export function mapOmpModel(model: OmpModel, provider: AgentProvider): AgentModelDefinition {
  const { thinkingOptions, defaultThinkingOptionId } = resolveOmpThinkingConfig(model);
  return {
    provider,
    id: `${model.provider}/${model.id}`,
    label: ompModelLabel(model),
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
  // `auto` is a session-level OMP mode, never a per-model effort, so models do not list it.
  const options = [OMP_THINKING_OPTIONS[0], ...filtered.filter((option) => option.id !== "auto")];
  return {
    thinkingOptions: options.map((option) =>
      mapThinkingOption(option, option.id === defaultThinkingOptionId),
    ),
    defaultThinkingOptionId,
  };
}
