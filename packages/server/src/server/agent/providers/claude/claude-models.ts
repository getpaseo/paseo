import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentModelDefinition } from "../../agent-sdk-types.js";

const CLAUDE_THINKING_OPTIONS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
] as const;

const CLAUDE_MODELS: AgentModelDefinition[] = [
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

interface ClaudeSettings {
  model?: string;
  [key: string]: unknown;
}

/**
 * Read custom model from ~/.claude/settings.json if configured.
 * Returns the custom model definition or null if not configured.
 */
async function readCustomModelFromSettings(): Promise<AgentModelDefinition | null> {
  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
    const settingsPath = path.join(configDir, "settings.json");

    const settingsContent = await fs.promises.readFile(settingsPath, "utf8");
    const settings: ClaudeSettings = JSON.parse(settingsContent);

    const customModel = settings.model;
    if (!customModel || typeof customModel !== "string") {
      return null;
    }

    // Don't return custom model if it's already in the built-in list
    const existingModelIds = new Set(CLAUDE_MODELS.map((m) => m.id));
    if (existingModelIds.has(customModel)) {
      return null;
    }

    return {
      provider: "claude",
      id: customModel,
      label: customModel,
      description: "Custom model from ~/.claude/settings.json",
    };
  } catch (error) {
    // Silently ignore errors - settings.json may not exist or be invalid
    return null;
  }
}

/**
 * Get Claude models including custom models from ~/.claude/settings.json.
 * The custom model (if configured and not already in the built-in list) is prepended.
 */
export async function getClaudeModels(): Promise<AgentModelDefinition[]> {
  const customModel = await readCustomModelFromSettings();

  const models = CLAUDE_MODELS.map((model) => ({ ...model }));

  if (customModel) {
    models.unshift(customModel);
  }

  return models;
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

  const family = runtimeMatch[1]!.toLowerCase();
  const major = runtimeMatch[2]!;
  const minor = runtimeMatch[3]!;
  const suffix = runtimeMatch[4] ?? "";
  return `claude-${family}-${major}-${minor}${suffix}`;
}
