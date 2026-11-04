import type {
  ProviderCatalog,
  ProviderLaunch,
  ProviderModel,
  ProviderMode,
  ProviderStatus,
} from "@getpaseo/plugin/server/provider";
import { probe } from "./process.js";
import { AntigravityError } from "./wire.js";

export type AntigravityModeId = "default" | "accept-edits" | "full-access";

export const DEFAULT_MODE: AntigravityModeId = "default";

export const modes: readonly ProviderMode[] = [
  {
    id: "default",
    icon: "ShieldCheck",
    colorTier: "safe",
    label: "Default",
    description: "Asks for permission before running shell commands or editing files.",
  },
  {
    id: "accept-edits",
    icon: "ShieldAlert",
    colorTier: "moderate",
    label: "Accept edits",
    description: "Automatically approves file edits and reads; asks before shell commands.",
  },
  {
    id: "full-access",
    icon: "ShieldOff",
    colorTier: "dangerous",
    label: "Full access",
    description: "Automatically approves all tool calls and shell commands without asking.",
    isUnattended: true,
  },
];

interface ModelPricing {
  inputCostPerM: number;
  outputCostPerM: number;
  cachedInputCostPerM: number;
}

const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "gemini-4-argon": 1_048_576,
  "gemini-3.8-flash": 1_048_576,
  "gemini-3.7-flash": 1_048_576,
  "gemini-3.6-flash": 1_048_576,
  "gemini-3.1-pro": 2_097_152,
  "claude-opus-5-5": 200_000,
  "claude-sonnet-5-5": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-opus-4-6": 200_000,
  "gpt-oss-120b": 128_000,
};

const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  "gemini-4-argon": { inputCostPerM: 1.25, outputCostPerM: 5.0, cachedInputCostPerM: 0.3125 },
  "gemini-3.8-flash": { inputCostPerM: 0.1, outputCostPerM: 0.4, cachedInputCostPerM: 0.025 },
  "gemini-3.7-flash": { inputCostPerM: 0.1, outputCostPerM: 0.4, cachedInputCostPerM: 0.025 },
  "gemini-3.6-flash": { inputCostPerM: 0.1, outputCostPerM: 0.4, cachedInputCostPerM: 0.025 },
  "gemini-3.1-pro": { inputCostPerM: 1.25, outputCostPerM: 5.0, cachedInputCostPerM: 0.3125 },
  "claude-opus-5-5": { inputCostPerM: 15.0, outputCostPerM: 75.0, cachedInputCostPerM: 1.5 },
  "claude-sonnet-5-5": { inputCostPerM: 3.0, outputCostPerM: 15.0, cachedInputCostPerM: 0.3 },
  "claude-sonnet-4-6": { inputCostPerM: 3.0, outputCostPerM: 15.0, cachedInputCostPerM: 0.3 },
  "claude-opus-4-6": { inputCostPerM: 15.0, outputCostPerM: 75.0, cachedInputCostPerM: 1.5 },
  "gpt-oss-120b": { inputCostPerM: 0.15, outputCostPerM: 0.6, cachedInputCostPerM: 0.0375 },
};

function normalizeBaseModelId(modelId: string): string {
  return modelId
    .trim()
    .replace(/^antigravity\//i, "")
    .replace(/-(?:minimal|low|medium|high|xhigh|max|ultra|thinking)$/i, "")
    .toLowerCase();
}

export function inferModelContextWindow(modelId: string | null | undefined): number | undefined {
  if (!modelId) return undefined;
  const base = normalizeBaseModelId(modelId);
  const exact = MODEL_CONTEXT_WINDOWS[base];
  if (exact !== undefined) return exact;
  if (base.includes("argon") || base.includes("flash")) return 1_048_576;
  if (base.startsWith("gemini-") && base.includes("pro")) return 2_097_152;
  if (base.startsWith("gemini-")) return 1_048_576;
  if (base.includes("claude") || base.includes("opus") || base.includes("sonnet")) return 200_000;
  if (base.includes("gpt")) return 128_000;
  return undefined;
}

export function estimateModelCostUsd(
  modelId: string | null | undefined,
  tokens: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number },
): number | undefined {
  if (!modelId) return undefined;
  const base = normalizeBaseModelId(modelId);
  let pricing: ModelPricing | undefined = MODEL_PRICING[base];
  if (!pricing) {
    if (base.includes("argon")) pricing = MODEL_PRICING["gemini-4-argon"];
    else if (base.includes("opus")) pricing = MODEL_PRICING["claude-opus-4-6"];
    else if (base.includes("claude") || base.includes("sonnet"))
      pricing = MODEL_PRICING["claude-sonnet-4-6"];
    else if (base.startsWith("gemini-") && base.includes("pro"))
      pricing = MODEL_PRICING["gemini-3.1-pro"];
    else if (base.includes("flash")) pricing = MODEL_PRICING["gemini-3.8-flash"];
    else if (base.includes("gpt-oss")) pricing = MODEL_PRICING["gpt-oss-120b"];
  }
  if (!pricing) return undefined;
  const input = tokens.inputTokens ?? 0;
  const output = tokens.outputTokens ?? 0;
  const cached = tokens.cachedInputTokens ?? 0;
  return (
    (input / 1_000_000) * pricing.inputCostPerM +
    (output / 1_000_000) * pricing.outputCostPerM +
    (cached / 1_000_000) * pricing.cachedInputCostPerM
  );
}

export async function getCatalog(launch: ProviderLaunch, cwd?: string): Promise<ProviderCatalog> {
  const output = await probe({ launch, args: ["models"], cwd });
  const models: ProviderModel[] = [];
  for (const line of output.trim().split(/\r?\n/)) {
    const [id, label, ...extra] = line.split("\t");
    if (!id || !label || extra.length > 0)
      throw new AntigravityError("Invalid `agy models` output", "INVALID_CATALOG");
    if (models.some((model) => model.id === id))
      throw new AntigravityError(`Duplicate Antigravity model: ${id}`, "INVALID_CATALOG");
    const contextWindowMaxTokens = inferModelContextWindow(id);
    models.push({
      id,
      label,
      ...(contextWindowMaxTokens !== undefined ? { contextWindowMaxTokens } : {}),
    });
  }
  return { models, modes, thinkingOptions: [], defaultMode: DEFAULT_MODE };
}

export async function getStatus(launch: ProviderLaunch): Promise<ProviderStatus> {
  try {
    const version = (await probe({ launch, args: ["--version"] })).trim();
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match)
      return {
        available: false,
        diagnostic: "Could not read the Antigravity version. Update `agy` to 1.4.0 or later.",
      };
    const [, major, minor] = match.map(Number);
    const supported = major > 1 || (major === 1 && minor >= 4);
    if (!supported)
      return {
        available: false,
        diagnostic: `Antigravity ${version} is unsupported. Update \`agy\` to 1.4.0 or later.`,
      };
    try {
      await probe({ launch, args: ["acp", "--help"] });
    } catch {
      return {
        available: false,
        diagnostic: `Antigravity ${version} does not support \`agy acp --stdio\`. Update \`agy\` to 1.4.0 or later.`,
      };
    }
    await getCatalog(launch);
    return { available: true };
  } catch (error) {
    if (!(error instanceof AntigravityError)) throw error;
    return { available: false, diagnostic: error.message };
  }
}

export function validateSelection(
  config: { model?: string; mode?: string; thinkingOption?: string },
  catalog: ProviderCatalog,
): void {
  if (config.model && !catalog.models.some((model) => model.id === config.model))
    throw new AntigravityError(`Unknown Antigravity model: ${config.model}`, "INVALID_MODEL");
  if (config.mode && !catalog.modes.some((mode) => mode.id === config.mode))
    throw new AntigravityError(`Unknown Antigravity mode: ${config.mode}`, "INVALID_MODE");
  if (config.thinkingOption)
    throw new AntigravityError(
      "Antigravity effort is selected through the model ID",
      "UNSUPPORTED_THINKING",
    );
}
