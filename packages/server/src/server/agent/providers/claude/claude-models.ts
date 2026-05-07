import type { AgentModelDefinition } from "../../agent-sdk-types.js";

const CLAUDE_THINKING_OPTIONS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
] as const;

const CLAUDE_OPUS_4_7_THINKING_OPTIONS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
] as const;

const CLAUDE_MODELS: AgentModelDefinition[] = [
  {
    provider: "claude",
    id: "claude-opus-4-7[1m]",
    label: "Opus 4.7 1M",
    description: "Opus 4.7 with 1M context window",
    thinkingOptions: [...CLAUDE_OPUS_4_7_THINKING_OPTIONS],
  },
  {
    provider: "claude",
    id: "claude-opus-4-7",
    label: "Opus 4.7",
    description: "Opus 4.7 · Latest release",
    thinkingOptions: [...CLAUDE_OPUS_4_7_THINKING_OPTIONS],
  },
  {
    provider: "claude",
    id: "claude-opus-4-6[1m]",
    label: "Opus 4.6 1M",
    description: "Opus 4.6 with 1M context window",
    thinkingOptions: [...CLAUDE_THINKING_OPTIONS],
  },
  {
    provider: "claude",
    id: "claude-opus-4-6",
    label: "Opus 4.6",
    description: "Opus 4.6 · Most capable for complex work",
    isDefault: true,
    thinkingOptions: [...CLAUDE_THINKING_OPTIONS],
  },
  {
    provider: "claude",
    id: "claude-sonnet-4-6[1m]",
    label: "Sonnet 4.6 1M",
    description: "Sonnet 4.6 with 1M context window",
    thinkingOptions: [...CLAUDE_THINKING_OPTIONS],
  },
  {
    provider: "claude",
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    description: "Sonnet 4.6 · Best for everyday tasks",
    thinkingOptions: [...CLAUDE_THINKING_OPTIONS],
  },
  {
    provider: "claude",
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    description: "Haiku 4.5 · Fastest for quick answers",
  },
];

export function getClaudeModels(): AgentModelDefinition[] {
  return CLAUDE_MODELS.map((model) => ({ ...model }));
}

/**
 * Normalize a runtime model string (from SDK init message) to a known model ID.
 * Handles the `[1m]` suffix that the SDK appends for 1M context sessions.
 */
export function normalizeClaudeRuntimeModelId(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return null;
  }

  // Check for exact match first (handles claude-opus-4-6[1m] directly)
  if (CLAUDE_MODELS.some((model) => model.id === trimmed)) {
    return trimmed;
  }

  // Match: claude-{family}-{major}-{minor}[1m]? possibly followed by a date suffix
  const runtimeMatch = trimmed.match(
    /(?:claude-)?(opus|sonnet|haiku)[-_ ]+(\d+)[-.](\d+)(\[1m\])?/i,
  );
  if (!runtimeMatch) {
    return null;
  }

  const family = runtimeMatch[1].toLowerCase();
  const major = runtimeMatch[2];
  const minor = runtimeMatch[3];
  const suffix = runtimeMatch[4] ?? "";
  return `claude-${family}-${major}-${minor}${suffix}`;
}
