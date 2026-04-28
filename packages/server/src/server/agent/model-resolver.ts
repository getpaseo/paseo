import { buildProviderRegistry } from "./provider-registry.js";
import { resolveSnapshotCwd } from "./provider-snapshot-manager.js";
import type { AgentProvider } from "./agent-sdk-types.js";
import { expandTilde } from "../../utils/path.js";
import type { Logger } from "pino";

interface ResolveAgentModelOptions {
  provider: AgentProvider;
  requestedModel?: string | null;
  cwd?: string;
  logger: Logger;
}

export async function resolveAgentModel(
  options: ResolveAgentModelOptions,
): Promise<string | undefined> {
  try {
    const providerRegistry = buildProviderRegistry(options.logger);
    const providerDefinition = providerRegistry[options.provider];
    if (!providerDefinition.enabled) {
      throw new Error(`Provider '${options.provider}' is disabled`);
    }

    const trimmed = options.requestedModel?.trim();
    if (trimmed) {
      return trimmed;
    }

    const models = await providerDefinition.fetchModels({
      cwd: resolveSnapshotCwd(options.cwd ? expandTilde(options.cwd) : undefined),
      force: false,
    });
    const preferred = models.find((model) => model.isDefault) ?? models[0];
    return preferred?.id;
  } catch (error) {
    options.logger.warn(
      { err: error, provider: options.provider },
      "Failed to resolve default model",
    );
    return undefined;
  }
}
