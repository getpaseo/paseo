import { fetchProviderModels } from "./provider-registry.js";
import type { AgentProvider } from "./agent-sdk-types.js";
import { expandTilde } from "../../utils/path.js";

type ResolveAgentModelOptions = {
  provider: AgentProvider;
  requestedModel?: string | null;
  cwd?: string;
};

export async function resolveAgentModel(
  options: ResolveAgentModelOptions
): Promise<string | undefined> {
  const trimmed = options.requestedModel?.trim();
  if (trimmed) {
    return trimmed;
  }

  try {
    const models = await fetchProviderModels(options.provider, {
      cwd: options.cwd ? expandTilde(options.cwd) : undefined,
    });
    const preferred = models.find((model) => model.isDefault) ?? models[0];
    return preferred?.id;
  } catch (error) {
    console.warn(
      `[AgentModelResolver] Failed to resolve default model for ${options.provider}:`,
      error
    );
    return undefined;
  }
}
