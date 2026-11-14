import type { ClientSideConnection, SessionConfigOption } from "@agentclientprotocol/sdk";
import type { Logger } from "pino";

import type { AgentModelDefinition } from "../agent-sdk-types.js";
import {
  type ACPCatalogModelResolverContext,
  type ACPModelWriteResult,
  type ConfigOptionSelector,
  deriveSelectorOptions,
  deriveSelectorOptionsById,
  findSelectConfigOption,
} from "./acp-agent.js";
import { toDiagnosticErrorMessage } from "./diagnostic-utils.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

const PROVIDER_CONFIG_ID = "provider";
// A reachable-but-unconfigured provider can block in its constructor (goose's own
// "local" provider does), so one probe must not be able to eat the refresh budget.
const PROVIDER_PROBE_TIMEOUT_MS = 8000;

interface GooseACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
}

function collectProviderModels({
  configOptions,
  gooseProvider,
  activeProvider,
  provider,
}: {
  configOptions: SessionConfigOption[];
  gooseProvider: ConfigOptionSelector;
  activeProvider: string | undefined;
  provider: string;
}): AgentModelDefinition[] {
  const thinkingOptions = deriveSelectorOptions(configOptions, "thought_level");
  const defaultThinkingOptionId = thinkingOptions.find((entry) => entry.isDefault)?.id;
  const models: AgentModelDefinition[] = [];
  for (const model of deriveSelectorOptions(configOptions, "model")) {
    // Providers with nothing configured advertise a single empty-valued model.
    if (!model.id.trim()) {
      continue;
    }
    models.push({
      provider,
      id: `${gooseProvider.id}/${model.id}`,
      label: model.label,
      description: gooseProvider.label,
      isDefault: gooseProvider.id === activeProvider && model.isDefault,
      thinkingOptions: thinkingOptions.length > 0 ? thinkingOptions : undefined,
      defaultThinkingOptionId,
      metadata: model.metadata,
    });
  }
  return models;
}

// goose advertises only the active provider's models, and its provider select carries
// no category. Walk every provider it offers and namespace the ids so the composer can
// pick a model from any of them.
export async function resolveGooseCatalogModels({
  connection,
  sessionId,
  models,
  configOptions,
  runRequest,
  transformConfigOptions,
  logger,
  provider,
}: ACPCatalogModelResolverContext): Promise<AgentModelDefinition[]> {
  const providerOptions = deriveSelectorOptionsById(configOptions, PROVIDER_CONFIG_ID);
  if (providerOptions.length === 0) {
    return models;
  }

  const activeProvider = providerOptions.find((option) => option.isDefault)?.id;
  const resolved: AgentModelDefinition[] = [];
  try {
    for (const option of providerOptions) {
      try {
        const response = await withProbeTimeout(
          runRequest(() =>
            connection.setSessionConfigOption({
              sessionId,
              configId: PROVIDER_CONFIG_ID,
              value: option.id,
            }),
          ),
        );
        resolved.push(
          ...collectProviderModels({
            configOptions: transformConfigOptions(response.configOptions ?? []),
            gooseProvider: option,
            activeProvider,
            provider,
          }),
        );
      } catch (error) {
        logger.warn(
          { gooseProvider: option.id, error: toDiagnosticErrorMessage(error) },
          `${provider} catalog probe could not resolve models for provider "${option.id}"; skipping it`,
        );
      }
    }
  } finally {
    // goose persists the active provider on every switch, so put the user's choice back.
    if (activeProvider) {
      await runRequest(() =>
        connection.setSessionConfigOption({
          sessionId,
          configId: PROVIDER_CONFIG_ID,
          value: activeProvider,
        }),
      ).catch(() => undefined);
    }
  }

  return resolved.length > 0 ? resolved : models;
}

export async function writeGooseModel(
  connection: ClientSideConnection,
  sessionId: string,
  modelId: string,
): Promise<ACPModelWriteResult> {
  const separator = modelId.indexOf("/");
  const gooseProvider = separator > 0 ? modelId.slice(0, separator) : null;
  const gooseModelId = separator > 0 ? modelId.slice(separator + 1) : modelId;

  let configOptions: SessionConfigOption[] = [];
  if (gooseProvider) {
    const response = await connection.setSessionConfigOption({
      sessionId,
      configId: PROVIDER_CONFIG_ID,
      value: gooseProvider,
    });
    configOptions = response.configOptions ?? [];
  }

  const response = await connection.setSessionConfigOption({
    sessionId,
    configId: findModelConfigId(configOptions),
    value: gooseModelId,
  });
  const finalConfigOptions = response.configOptions ?? [];
  return {
    configOptions: finalConfigOptions,
    modelConfigId: findModelConfigId(finalConfigOptions),
  };
}

function findModelConfigId(configOptions: SessionConfigOption[]): string {
  return findSelectConfigOption({ configOptions, category: "model" })?.id ?? "model";
}

async function withProbeTimeout<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${PROVIDER_PROBE_TIMEOUT_MS}ms`)),
          PROVIDER_PROBE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export class GooseACPAgentClient extends GenericACPAgentClient {
  constructor(options: GooseACPAgentClientOptions) {
    super({
      ...options,
      catalogModelResolver: resolveGooseCatalogModels,
      modelWriter: writeGooseModel,
    });
  }
}
