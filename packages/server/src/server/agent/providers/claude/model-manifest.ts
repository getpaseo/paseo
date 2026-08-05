import type { AgentModelDefinition, AgentSelectOption } from "../../agent-sdk-types.js";

type ClaudeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

interface ClaudeModelManifestEntry {
  id: string;
  label: string;
  description: string;
  defaultPriority?: number;
  minimumClaudeCodeVersion?: string;
  contextWindowMaxTokens?: number;
  effortLevels?: readonly ClaudeEffortLevel[];
  supportsThinkingDisabled?: boolean;
  supportsFastMode?: boolean;
}

const CLAUDE_EFFORT_LEVELS = {
  standard: ["low", "medium", "high", "max"],
  xhigh: ["low", "medium", "high", "xhigh", "max"],
} as const satisfies Record<string, readonly ClaudeEffortLevel[]>;

const CLAUDE_EFFORT_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
} as const satisfies Record<ClaudeEffortLevel, string>;

export const CLAUDE_DEFAULT_THINKING_OPTION_ID = "high";

export const CLAUDE_DISABLED_THINKING_OPTION_ID = "off";
export const CLAUDE_ULTRACODE_THINKING_OPTION_ID = "ultracode";

export const CLAUDE_MODEL_MANIFEST = [
  {
    id: "claude-opus-5",
    label: "Opus 5",
    description: "Opus 5 · Latest release",
    defaultPriority: 2,
    minimumClaudeCodeVersion: "2.1.219",
    contextWindowMaxTokens: 1_000_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.xhigh,
    supportsThinkingDisabled: true,
  },
  {
    id: "claude-fable-5",
    label: "Fable 5",
    description: "Fable 5 · Most powerful model",
    minimumClaudeCodeVersion: "2.1.169",
    contextWindowMaxTokens: 1_000_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.xhigh,
  },
  {
    id: "claude-opus-4-8[1m]",
    label: "Opus 4.8 1M",
    description: "Opus 4.8 with 1M context window",
    contextWindowMaxTokens: 1_000_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.xhigh,
    supportsThinkingDisabled: true,
    supportsFastMode: true,
  },
  {
    id: "claude-opus-4-8",
    label: "Opus 4.8",
    description: "Opus 4.8 · Previous release",
    defaultPriority: 1,
    contextWindowMaxTokens: 200_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.xhigh,
    supportsThinkingDisabled: true,
    supportsFastMode: true,
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    description: "Sonnet 5 · Best for everyday tasks",
    contextWindowMaxTokens: 200_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.xhigh,
    supportsThinkingDisabled: true,
  },
  {
    id: "claude-sonnet-5[1m]",
    label: "Sonnet 5 1M",
    description: "Sonnet 5 with 1M context window",
    contextWindowMaxTokens: 1_000_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.xhigh,
    supportsThinkingDisabled: true,
  },
  {
    id: "claude-opus-4-7[1m]",
    label: "Opus 4.7 1M",
    description: "Opus 4.7 with 1M context window",
    contextWindowMaxTokens: 1_000_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.xhigh,
    supportsThinkingDisabled: true,
    supportsFastMode: true,
  },
  {
    id: "claude-opus-4-7",
    label: "Opus 4.7",
    description: "Opus 4.7 · Previous release",
    contextWindowMaxTokens: 200_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.xhigh,
    supportsThinkingDisabled: true,
    supportsFastMode: true,
  },
  {
    id: "claude-opus-4-6[1m]",
    label: "Opus 4.6 1M",
    description: "Opus 4.6 with 1M context window",
    contextWindowMaxTokens: 1_000_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.standard,
    supportsThinkingDisabled: true,
    supportsFastMode: true,
  },
  {
    id: "claude-opus-4-6",
    label: "Opus 4.6",
    description: "Opus 4.6 · Most capable for complex work",
    contextWindowMaxTokens: 200_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.standard,
    supportsThinkingDisabled: true,
    supportsFastMode: true,
  },
  {
    id: "claude-sonnet-4-6[1m]",
    label: "Sonnet 4.6 1M",
    description: "Sonnet 4.6 with 1M context window",
    contextWindowMaxTokens: 1_000_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.standard,
    supportsThinkingDisabled: true,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    description: "Sonnet 4.6 · Best for everyday tasks",
    contextWindowMaxTokens: 200_000,
    effortLevels: CLAUDE_EFFORT_LEVELS.standard,
    supportsThinkingDisabled: true,
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    description: "Haiku 4.5 · Fastest for quick answers",
    contextWindowMaxTokens: 200_000,
  },
] as const satisfies readonly ClaudeModelManifestEntry[];

function buildThinkingOptions(
  effortLevels: readonly ClaudeEffortLevel[] | undefined,
  supportsThinkingDisabled: boolean,
): AgentSelectOption[] | undefined {
  if (!effortLevels) {
    return undefined;
  }

  const options: AgentSelectOption[] = [
    ...(supportsThinkingDisabled ? [{ id: CLAUDE_DISABLED_THINKING_OPTION_ID, label: "Off" }] : []),
    ...effortLevels.map((id) => ({
      id,
      label: CLAUDE_EFFORT_LABELS[id],
      ...(id === CLAUDE_DEFAULT_THINKING_OPTION_ID ? { isDefault: true } : {}),
    })),
  ];

  if (effortLevels.includes("xhigh")) {
    options.push({ id: CLAUDE_ULTRACODE_THINKING_OPTION_ID, label: "Ultra Code" });
  }

  return options;
}

export function getClaudeManifestModels(claudeCodeVersion?: string): AgentModelDefinition[] {
  const availableModels: readonly ClaudeModelManifestEntry[] = CLAUDE_MODEL_MANIFEST.filter(
    (model) => isModelAvailableInClaudeCode(model, claudeCodeVersion),
  );
  const defaultModel = availableModels.reduce<ClaudeModelManifestEntry | undefined>(
    (selected, candidate) =>
      (candidate.defaultPriority ?? 0) > (selected?.defaultPriority ?? 0) ? candidate : selected,
    undefined,
  );

  return availableModels.map((model) => {
    const thinkingOptions = buildThinkingOptions(
      model.effortLevels,
      model.supportsThinkingDisabled === true,
    );
    const definition: AgentModelDefinition = {
      provider: "claude",
      id: model.id,
      label: model.label,
      description: model.description,
    };
    if (model === defaultModel) {
      definition.isDefault = true;
    }
    if (model.contextWindowMaxTokens !== undefined) {
      definition.contextWindowMaxTokens = model.contextWindowMaxTokens;
    }
    if (thinkingOptions) {
      definition.thinkingOptions = thinkingOptions;
      definition.defaultThinkingOptionId = CLAUDE_DEFAULT_THINKING_OPTION_ID;
    }
    return definition;
  });
}

function isModelAvailableInClaudeCode(
  model: ClaudeModelManifestEntry,
  claudeCodeVersion: string | undefined,
): boolean {
  if (!model.minimumClaudeCodeVersion || claudeCodeVersion === undefined) {
    return true;
  }
  return compareVersions(claudeCodeVersion, model.minimumClaudeCodeVersion) >= 0;
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseClaudeCodeVersion(left);
  const rightParts = parseClaudeCodeVersion(right);
  if (!leftParts || !rightParts) {
    return -1;
  }
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function parseClaudeCodeVersion(value: string): [number, number, number] | null {
  const match =
    value.match(/\b(\d+)\.(\d+)\.(\d+)\s+\(Claude Code\)/i) ??
    value.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export interface ClaudeDisabledThinkingResolution {
  supported: boolean;
  fallbackThinkingOptionId: string | undefined;
}

/**
 * Resolve the disabled-thinking capability from the curated manifest only. Runtime/provider
 * model aliases intentionally do not inherit this capability.
 */
export function resolveClaudeDisabledThinkingForModel(
  modelId: string | null | undefined,
): ClaudeDisabledThinkingResolution {
  const normalizedModelId = normalizeClaudeManifestModelId(modelId);
  const model = normalizedModelId
    ? CLAUDE_MODEL_MANIFEST.find((candidate) => candidate.id === normalizedModelId)
    : undefined;
  return {
    supported:
      !!model && "supportsThinkingDisabled" in model && model.supportsThinkingDisabled === true,
    fallbackThinkingOptionId:
      model && "effortLevels" in model ? CLAUDE_DEFAULT_THINKING_OPTION_ID : undefined,
  };
}

export function isClaudeManifestModelId(modelId: string): boolean {
  return CLAUDE_MODEL_MANIFEST.some((model) => model.id === modelId);
}

export function claudeManifestModelSupportsFastMode(modelId: string | null | undefined): boolean {
  const normalizedModelId = normalizeClaudeManifestModelId(modelId);
  if (!normalizedModelId) {
    return false;
  }
  return CLAUDE_MODEL_MANIFEST.some(
    (model) =>
      model.id === normalizedModelId &&
      "supportsFastMode" in model &&
      model.supportsFastMode === true,
  );
}

/**
 * Normalize first-party Claude model IDs for manifest capability checks. Provider-prefixed
 * runtime IDs intentionally use normalizeClaudeRuntimeModelId instead.
 */
export function normalizeClaudeManifestModelId(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return null;
  }

  if (isClaudeManifestModelId(trimmed)) {
    return trimmed;
  }

  const singleSegmentMatch = trimmed.match(
    /^(?:claude[-_ ])?(fable|opus|sonnet|haiku)[-_ ]+(\d+)(?:\[1m\])?(?:[-_ ]+\d{8})?(?:\[1m\])?$/i,
  );
  if (singleSegmentMatch) {
    return normalizeSingleSegmentClaudeModelId(
      singleSegmentMatch[1],
      singleSegmentMatch[2],
      trimmed.toLowerCase().includes("[1m]"),
    );
  }

  const runtimeMatch = trimmed.match(
    /^(?:claude[-_ ])?(opus|sonnet|haiku)[-_ ]+(\d+)[-.](\d+)(?:\[1m\])?(?:[-_ ]+\d{8})?(?:\[1m\])?$/i,
  );
  if (!runtimeMatch) {
    return null;
  }

  return normalizeMajorMinorClaudeModelId(
    runtimeMatch[1],
    runtimeMatch[2],
    runtimeMatch[3],
    trimmed.toLowerCase().includes("[1m]"),
  );
}

/**
 * Normalize a Claude Code runtime/config model string to a known manifest ID.
 * Runtime metadata may include provider prefixes such as Bedrock model IDs; feature
 * gates should use normalizeClaudeManifestModelId instead.
 */
export function normalizeClaudeRuntimeModelId(value: string | null | undefined): string | null {
  const normalizedManifestModelId = normalizeClaudeManifestModelId(value);
  if (normalizedManifestModelId) {
    return normalizedManifestModelId;
  }

  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return null;
  }

  const singleSegmentMatch = trimmed.match(
    /claude[-_ ](fable|opus|sonnet|haiku)[-_ ]+(\d+)(\[1m\])?/i,
  );
  if (singleSegmentMatch) {
    const normalizedModelId = normalizeSingleSegmentClaudeModelId(
      singleSegmentMatch[1],
      singleSegmentMatch[2],
      trimmed.toLowerCase().includes("[1m]"),
    );
    if (normalizedModelId) {
      return normalizedModelId;
    }
  }

  const runtimeMatch = trimmed.match(
    /claude[-_ ](opus|sonnet|haiku)[-_ ]+(\d+)[-.](\d+)(\[1m\])?/i,
  );
  if (!runtimeMatch) {
    return null;
  }

  return normalizeMajorMinorClaudeModelId(
    runtimeMatch[1],
    runtimeMatch[2],
    runtimeMatch[3],
    trimmed.toLowerCase().includes("[1m]"),
  );
}

/** Canonicalize retired first-party IDs before passing stored configs back to Claude Code. */
// COMPAT(claudeFable5OneMillionId): added in v0.3.0, remove after 2027-02-06 once pre-v0.3.0 persisted Claude configs are outside support.
export function normalizeClaudeConfiguredModelId(modelId: string): string {
  const trimmed = modelId.trim();
  return /^claude-fable-5(?:-\d{8})?\[1m\]$/i.test(trimmed) ? "claude-fable-5" : trimmed;
}

export function getClaudeCustomModelThinkingOptions(): AgentSelectOption[] {
  return CLAUDE_EFFORT_LEVELS.standard.map((id) => {
    const option: AgentSelectOption = { id, label: CLAUDE_EFFORT_LABELS[id] };
    if (id === CLAUDE_DEFAULT_THINKING_OPTION_ID) option.isDefault = true;
    return option;
  });
}

function normalizeSingleSegmentClaudeModelId(
  familyValue: string,
  major: string,
  hasOneMillionContext: boolean,
): string | null {
  const family = familyValue.toLowerCase();
  const suffix = hasOneMillionContext ? "[1m]" : "";
  const candidates = [`claude-${family}-${major}${suffix}`, `claude-${family}-${major}`];
  for (const candidate of candidates) {
    if (isClaudeManifestModelId(candidate)) {
      return candidate;
    }
  }
  return null;
}

function normalizeMajorMinorClaudeModelId(
  familyValue: string,
  major: string,
  minor: string,
  hasOneMillionContext: boolean,
): string | null {
  const family = familyValue.toLowerCase();
  const suffix = hasOneMillionContext ? "[1m]" : "";
  const candidate = `claude-${family}-${major}-${minor}${suffix}`;
  return isClaudeManifestModelId(candidate) ? candidate : null;
}
