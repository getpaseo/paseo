import type { Logger } from "pino";

import type { AgentModelDefinition, AgentSessionConfig } from "../agent-sdk-types.js";
import {
  type ACPCatalogModelResolverContext,
  type ACPConfigFeatureOption,
  deriveThinkingSelectorOptions,
  findSelectConfigOption,
} from "./acp-agent.js";
import { toDiagnosticErrorMessage } from "./diagnostic-utils.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

interface CursorACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

const CURSOR_INITIAL_COMMANDS_WAIT_TIMEOUT_MS = 10_000;
const CURSOR_CLIENT_CAPABILITY_META = {
  parameterizedModelPicker: true,
};
const CURSOR_PARAMETERIZED_MODEL_ID = /^([^[\]]+)\[(.*)\]$/;

export const CURSOR_FAST_FEATURE_OPTION: ACPConfigFeatureOption = {
  id: "fast",
  configId: "fast",
  label: "Fast",
  description: "Cursor fast mode",
  tooltip: "Select Cursor fast mode",
  icon: "zap",
};

export const CURSOR_CONTEXT_FEATURE_OPTION: ACPConfigFeatureOption = {
  id: "context",
  configId: "context",
  label: "Context",
  description: "Cursor context window",
  tooltip: "Select Cursor context window",
};

/**
 * Cursor ACP only exposes the currently selected model's effort / reasoning /
 * Fast / context pickers. The model list itself is a set of base IDs. Probe
 * each model on the catalog session so Grok does not inherit K3's
 * low/high/max, and Composer is not given a thinking chip.
 */
export async function resolveCursorCatalogModels({
  connection,
  sessionId,
  models,
  configOptions,
  runRequest,
  transformConfigOptions,
  logger,
  provider,
}: ACPCatalogModelResolverContext): Promise<AgentModelDefinition[]> {
  if (models.length <= 1) {
    return models.map((model) => applyCursorThinkingOptions(model, configOptions));
  }
  const modelOption = findSelectConfigOption({ configOptions, category: "model" });
  if (!modelOption) {
    return models.map((model) => applyCursorThinkingOptions(model, configOptions));
  }

  const resolved: AgentModelDefinition[] = [];
  for (const model of models) {
    if (model.isDefault) {
      resolved.push(applyCursorThinkingOptions(model, configOptions));
      continue;
    }
    try {
      const response = await runRequest(() =>
        connection.setSessionConfigOption({
          sessionId,
          configId: modelOption.id,
          value: model.id,
        }),
      );
      resolved.push(
        applyCursorThinkingOptions(model, transformConfigOptions(response.configOptions ?? [])),
      );
    } catch (error) {
      logger.warn(
        { modelId: model.id, error: toDiagnosticErrorMessage(error) },
        `${provider} catalog probe could not resolve thinking options for model "${model.id}"; leaving thinking unset`,
      );
      resolved.push(applyCursorThinkingOptions(model, null));
    }
  }
  return resolved;
}

export function parseCursorModelId(modelId: string): {
  modelId: string;
  params: Record<string, string>;
} {
  const trimmed = modelId.trim();
  const match = CURSOR_PARAMETERIZED_MODEL_ID.exec(trimmed);
  if (!match) {
    return { modelId: trimmed, params: {} };
  }
  const params: Record<string, string> = {};
  const body = match[2].trim();
  if (body.length > 0) {
    for (const part of body.split(",")) {
      const separator = part.indexOf("=");
      if (separator <= 0) {
        continue;
      }
      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (key.length > 0) {
        params[key] = value;
      }
    }
  }
  return { modelId: match[1], params };
}

export function normalizeCursorSessionConfig(config: AgentSessionConfig): AgentSessionConfig {
  if (!config.model) {
    return config;
  }
  const parsed = parseCursorModelId(config.model);
  const modelUnchanged = parsed.modelId === config.model;
  const hasParams = Object.keys(parsed.params).length > 0;
  if (modelUnchanged && !hasParams) {
    return config;
  }
  const thinkingFromParams = parsed.params.effort ?? parsed.params.reasoning;
  const featureValues = { ...config.featureValues };
  if (parsed.params.fast !== undefined && featureValues.fast === undefined) {
    featureValues.fast = parsed.params.fast;
  }
  if (parsed.params.context !== undefined && featureValues.context === undefined) {
    featureValues.context = parsed.params.context;
  }
  return {
    ...config,
    model: parsed.modelId,
    thinkingOptionId: config.thinkingOptionId ?? thinkingFromParams,
    featureValues: Object.keys(featureValues).length > 0 ? featureValues : config.featureValues,
  };
}

function applyCursorThinkingOptions(
  model: AgentModelDefinition,
  configOptions: ACPCatalogModelResolverContext["configOptions"],
): AgentModelDefinition {
  const thinkingOptions = deriveThinkingSelectorOptions(configOptions);
  return {
    ...model,
    thinkingOptions: thinkingOptions.length > 0 ? thinkingOptions : undefined,
    defaultThinkingOptionId: thinkingOptions.find((option) => option.isDefault)?.id,
  };
}

export class CursorACPAgentClient extends GenericACPAgentClient {
  constructor(options: CursorACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      // cursor-agent publishes slash commands asynchronously via available_commands_update.
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: CURSOR_INITIAL_COMMANDS_WAIT_TIMEOUT_MS,
      clientCapabilityMeta: CURSOR_CLIENT_CAPABILITY_META,
      configFeatureOptions: [CURSOR_FAST_FEATURE_OPTION, CURSOR_CONTEXT_FEATURE_OPTION],
      catalogModelResolver: resolveCursorCatalogModels,
    });
  }

  protected override transformSessionConfig(config: AgentSessionConfig): AgentSessionConfig {
    return normalizeCursorSessionConfig(config);
  }
}
