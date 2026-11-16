import type {
  ProviderCatalog,
  ProviderLaunch,
  ProviderModel,
  ProviderMode,
  ProviderStatus,
  ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";
import { probe } from "./process.js";
import { AntigravityError } from "./wire.js";

export interface ResolvedModelAndEffort {
  model?: string;
  effort?: string;
}

const modes: readonly ProviderMode[] = [
  {
    id: "full-access",
    icon: "ShieldOff",
    colorTier: "dangerous",
    label: "Full access",
    description:
      "Antigravity cannot ask for permission when another app drives it. Paseo starts it with --dangerously-skip-permissions.",
    isUnattended: true,
  },
  {
    id: "auto",
    icon: "Zap",
    colorTier: "caution",
    label: "Auto",
    description: "Run in Antigravity auto execution mode (--mode auto).",
    isUnattended: true,
  },
  {
    id: "accept-edits",
    icon: "FileEdit",
    colorTier: "caution",
    label: "Accept edits",
    description: "Approve file edits in the workspace without asking (--mode accept-edits).",
    isUnattended: false,
  },
  {
    id: "plan",
    icon: "ListTodo",
    colorTier: "safe",
    label: "Plan",
    description: "Plan carefully before executing a task (--mode plan).",
    isUnattended: false,
  },
];

export const GEMINI_THINKING_OPTIONS: readonly ProviderThinkingOption[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

export const GEMINI_XHIGH_THINKING_OPTIONS: readonly ProviderThinkingOption[] = [
  ...GEMINI_THINKING_OPTIONS,
  { id: "xhigh", label: "XHigh" },
];

export function getModelContextWindow(modelId: string): number {
  if (modelId.startsWith("claude-")) {
    return 200_000;
  }
  if (modelId.startsWith("gpt-")) {
    return 128_000;
  }
  return 1_048_576;
}

// agy only accepts --effort for models that come in low/medium/high(/xhigh) variants;
// anything else (e.g. gemini-pro-orchestrator, claude-*, gpt-oss-*) rejects the flag at startup.
const EFFORT_SUFFIX = /^(gemini-[^]+)-(low|medium|high|xhigh)$/;
const EFFORT_BASE_MODELS = new Set([
  "gemini-4-argon",
  "gemini-4-carbon",
  "gemini-4-hydrogen",
  "gemini-3.8-flash",
]);
const XHIGH_BASE_MODELS = new Set(["gemini-4-hydrogen"]);

export function supportsEffort(modelId?: string): boolean {
  if (!modelId) return true;
  return EFFORT_SUFFIX.test(modelId) || EFFORT_BASE_MODELS.has(modelId);
}

export function getThinkingOptionsForModel(
  modelId?: string,
  catalog?: ProviderCatalog,
): ProviderThinkingOption[] {
  if (!supportsEffort(modelId)) return [];
  if (modelId && catalog) {
    const found = catalog.models.find((model) => model.id === modelId);
    if (found?.thinkingOptions) return [...found.thinkingOptions];
  }
  const baseModel = modelId ? (EFFORT_SUFFIX.exec(modelId)?.[1] ?? modelId) : undefined;
  if (baseModel && XHIGH_BASE_MODELS.has(baseModel)) {
    return [...GEMINI_XHIGH_THINKING_OPTIONS];
  }
  return [...GEMINI_THINKING_OPTIONS];
}

export function resolveModelAndEffort(
  modelId?: string,
  thinkingOption?: string,
): ResolvedModelAndEffort {
  if (!modelId) {
    return { effort: thinkingOption };
  }
  if (!supportsEffort(modelId)) {
    return { model: modelId };
  }
  const suffixMatch = EFFORT_SUFFIX.exec(modelId);
  if (thinkingOption && suffixMatch) {
    return { model: suffixMatch[1], effort: thinkingOption };
  }
  return { model: modelId, effort: thinkingOption };
}

export async function getCatalog(launch: ProviderLaunch, cwd?: string): Promise<ProviderCatalog> {
  const output = await probe({ launch, args: ["models"], cwd });
  const models: ProviderModel[] = [
    {
      id: "gemini-4-argon",
      label: "Gemini 4 Argon",
      contextWindowMaxTokens: getModelContextWindow("gemini-4-argon"),
      thinkingOptions: [...GEMINI_THINKING_OPTIONS],
      defaultThinkingOptionId: "high",
    },
    {
      id: "gemini-3.8-flash",
      label: "Gemini 3.8 Flash",
      contextWindowMaxTokens: getModelContextWindow("gemini-3.8-flash"),
      thinkingOptions: [...GEMINI_THINKING_OPTIONS],
      defaultThinkingOptionId: "high",
    },
  ];
  for (const line of output.trim().split(/\r?\n/)) {
    const [id, label, ...extra] = line.split("\t");
    if (!id || !label || extra.length > 0)
      throw new AntigravityError("Invalid `agy models` output", "INVALID_CATALOG");
    if (models.some((model) => model.id === id))
      throw new AntigravityError(`Duplicate Antigravity model: ${id}`, "INVALID_CATALOG");
    const suffixMatch = EFFORT_SUFFIX.exec(id);
    const thinkingOptions = getThinkingOptionsForModel(id);
    models.push({
      id,
      label,
      contextWindowMaxTokens: getModelContextWindow(id),
      ...(thinkingOptions.length > 0
        ? {
            thinkingOptions,
            defaultThinkingOptionId: suffixMatch ? suffixMatch[2] : "high",
          }
        : {}),
    });
  }
  // Do not set top-level thinkingOptions or defaultThinkingOption on ProviderCatalog:
  // Paseo's mapModel() falls back to catalog.thinkingOptions when model.thinkingOptions
  // is undefined, which would wrongly expose effort options on gemini-pro-orchestrator*.
  return {
    models,
    modes,
    defaultModel: "gemini-3.8-flash-high",
    defaultMode: "full-access",
  };
}

export async function getStatus(launch: ProviderLaunch): Promise<ProviderStatus> {
  try {
    const version = (await probe({ launch, args: ["--version"] })).trim();
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match)
      return {
        available: false,
        diagnostic: "Could not read the Antigravity version. Update `agy` to 1.1.15 or later.",
      };
    const [, major, minor, patch] = match.map(Number);
    const supported = major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 15)));
    if (!supported)
      return {
        available: false,
        diagnostic: `Antigravity ${version} is unsupported. Update \`agy\` to 1.1.15 or later.`,
      };
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
  if (config.thinkingOption && supportsEffort(config.model)) {
    const allowed = getThinkingOptionsForModel(config.model, catalog);
    if (!allowed.some((option) => option.id === config.thinkingOption))
      throw new AntigravityError(
        `Unsupported Antigravity thinking option: ${config.thinkingOption}`,
        "UNSUPPORTED_THINKING",
      );
  }
}
