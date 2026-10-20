import type { Config } from "@opencode-ai/sdk/v2/client";
import type { AgentModelDefinition } from "../../agent-sdk-types.js";

// These IDs are runtime routes, not direct-API aliases. Keep gateway metadata intact.
const ACTIVE_MODELS: Record<string, readonly string[]> = {
  minimax: ["MiniMax-M3.1-Flash", "MiniMax-M3"],
  "minimax-cn": ["MiniMax-M3.1-Flash", "MiniMax-M3"],
  opencode: ["minimax-m3.1-flash-free", "minimax-m3"],
  openrouter: ["minimax/minimax-m3.1-flash:free", "minimax/minimax-m3"],
};

export function applyOpenCodeMiniMaxCatalog(
  models: AgentModelDefinition[],
  config: Config | undefined,
  isPaseoPlugin?: (specifier: string) => boolean,
): AgentModelDefinition[] {
  // Effective config includes auto-discovered local plugins. Their model hooks can
  // replace a built-in ID without changing its endpoint or provider source.
  if (
    !config ||
    config.plugin?.some((plugin) => !isPaseoPlugin?.(Array.isArray(plugin) ? plugin[0] : plugin))
  )
    return models;

  const managed = new Map<AgentModelDefinition, number>();
  const mapped = models.map((model) => {
    const providerId = model.metadata?.providerId;
    const modelId = model.metadata?.modelId;
    if (typeof providerId !== "string" || typeof modelId !== "string") return model;
    const active = ACTIVE_MODELS[providerId];
    if (!active) return model;
    const textModelId = providerId === "openrouter" ? modelId.replace(/^minimax\//, "") : modelId;
    if (!/^minimax-m\d/i.test(textModelId)) return model;
    // Config presence, not endpoint inequality, proves an explicit native override.
    if (config.provider?.[providerId] || model.metadata?.providerSource === "config") {
      return { ...model, metadata: { ...model.metadata, catalogOrigin: "custom" } };
    }
    const source = model.metadata?.providerSource;
    const knownSource = source === "api" || source === "env" || source === "custom";
    if (!knownSource) return model;
    const rank = active.indexOf(modelId);
    const next = {
      ...model,
      isVisibleInPicker: rank !== -1,
      metadata: { ...model.metadata, catalogOrigin: "builtin" },
    };
    managed.set(next, rank === -1 ? active.length : rank);
    return next;
  });
  // Reorder only managed MiniMax slots; other providers and explicit overrides keep their order.
  const ordered = mapped.filter((model) => managed.has(model));
  ordered.sort((a, b) => managed.get(a)! - managed.get(b)!);
  let index = 0;
  return mapped.map((model) => (managed.has(model) ? ordered[index++]! : model));
}
