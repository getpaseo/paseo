import type { AgentModelDefinition } from "../../agent-sdk-types.js";

/**
 * Temporary hardcoded Claude model catalog.
 *
 * Why:
 * - Claude SDK model discovery currently returns abstract options like
 *   "default", "opus", and "haiku".
 * - Runtime init messages report concrete model IDs like
 *   "claude-opus-4-6".
 * - That mismatch breaks model selection + thinking reconciliation in UI.
 *
 * We keep a single flat list with all model data in one place.
 * If Claude SDK model discovery becomes consistent with runtime IDs, switch
 * listModels back to SDK discovery and remove this file.
 */

export type ClaudeCatalogModel = {
  family: "sonnet" | "opus" | "haiku";
  modelId: string;
  name: string;
  description: string;
  isDefault?: boolean;
  isLatestInFamily?: boolean;
};

export const CLAUDE_MODEL_CATALOG: readonly ClaudeCatalogModel[] = [
  {
    family: "sonnet",
    modelId: "claude-sonnet-4-5-20250929",
    name: "Sonnet 4.5",
    description: "Sonnet 4.5 · Best for everyday tasks",
    isDefault: true,
    isLatestInFamily: true,
  },
  {
    family: "opus",
    modelId: "claude-opus-4-6",
    name: "Opus 4.6",
    description: "Opus 4.6 · Most capable for complex work",
    isLatestInFamily: true,
  },
  {
    family: "haiku",
    modelId: "claude-haiku-4-5-20251001",
    name: "Haiku 4.5",
    description: "Haiku 4.5 · Fastest for quick answers",
    isLatestInFamily: true,
  },
];

export type ClaudeModelFamily = ClaudeCatalogModel["family"];

function toClaudeModelDefinition(params: {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}): AgentModelDefinition {
  return {
    provider: "claude",
    id: params.id,
    label: params.label,
    description: params.description,
    ...(params.isDefault ? { isDefault: true } : {}),
    thinkingOptions: [
      { id: "off", label: "Off", isDefault: true },
      { id: "on", label: "On" },
    ],
    defaultThinkingOptionId: "off",
    metadata: params.description
      ? {
          description: params.description,
        }
      : undefined,
  };
}

export function listClaudeCatalogModels(): AgentModelDefinition[] {
  return CLAUDE_MODEL_CATALOG.map((model) =>
    toClaudeModelDefinition({
      id: model.modelId,
      label: model.name,
      description: model.description,
      isDefault: model.isDefault,
    })
  );
}

export function buildClaudeSelectableModelIds(): Set<string> {
  return new Set(CLAUDE_MODEL_CATALOG.map((model) => model.modelId));
}

export function buildClaudeModelFamilyAliases(): Map<ClaudeModelFamily, string> {
  const aliases = new Map<ClaudeModelFamily, string>();
  for (const model of CLAUDE_MODEL_CATALOG) {
    if (model.isLatestInFamily || !aliases.has(model.family)) {
      aliases.set(model.family, model.modelId);
    }
  }
  return aliases;
}
