import type { Logger } from "pino";

import type { AgentModelDefinition } from "../agent-sdk-types.js";
import {
  type ACPCatalogModelResolverContext,
  type ConfigOptionSelector,
  deriveSelectorOptions,
  findSelectConfigOption,
} from "./acp-agent.js";
import { toDiagnosticErrorMessage } from "./diagnostic-utils.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

interface KimiACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

/**
 * Kimi reports different thinking-effort levels per model (a boolean on/off toggle for one
 * model, a multi-level select for another), but only exposes the *currently selected*
 * model's levels through `configOptions` — the model list itself carries no per-model
 * effort metadata. `deriveModelDefinitionsFromACP` can only see whichever model the probe
 * session defaulted to, so every other model would otherwise inherit that one model's
 * thinking options.
 *
 * Reuse the single catalog probe session to switch through each candidate model in turn and
 * read back its real thinking options, rather than spawning a probe per model. Per-model
 * switching is skipped when the provider reports one model or no thinking picker, but
 * thinking options are still normalized so a lone K3 does not keep the invalid legacy "on".
 *
 * This lives on the Kimi client, not the base ACP adapter: only Kimi needs the extra
 * `setSessionConfigOption` round trips, so no other ACP provider risks a slow or
 * nonconforming agent stalling its catalog probe on model switching.
 */
// Drop the legacy on/off toggle when real effort levels are present; default unspecified effort to high.
const THINKING_TOGGLE_OPTION_IDS = new Set(["on", "off"]);
const KIMI_DEFAULT_EFFORT_OPTION_ID = "high";

function normalizeKimiThinkingOptions(options: ConfigOptionSelector[]): {
  options: ConfigOptionSelector[];
  defaultThinkingOptionId: string | undefined;
} {
  const efforts = options.filter(
    (option) => !THINKING_TOGGLE_OPTION_IDS.has(option.id.trim().toLowerCase()),
  );
  if (efforts.length === 0) {
    return { options, defaultThinkingOptionId: options.find((o) => o.isDefault)?.id };
  }

  const markedDefaultId = efforts.find((option) => option.isDefault)?.id;
  const defaultThinkingOptionId =
    markedDefaultId ??
    efforts.find((option) => option.id.trim().toLowerCase() === KIMI_DEFAULT_EFFORT_OPTION_ID)?.id;

  for (const option of efforts) {
    option.isDefault = option.id === defaultThinkingOptionId;
  }
  return { options: efforts, defaultThinkingOptionId };
}

function withNormalizedKimiThinkingOptions(model: AgentModelDefinition): AgentModelDefinition {
  if (!model.thinkingOptions?.length) {
    return model;
  }
  // Clone so models that share a thinkingOptions array (pre-probe derivation) aren't mutated
  // mid-map.
  const derived = model.thinkingOptions.map((option) => ({ ...option }));
  const { options: thinkingOptions, defaultThinkingOptionId } =
    normalizeKimiThinkingOptions(derived);
  return {
    ...model,
    thinkingOptions: thinkingOptions.length > 0 ? thinkingOptions : undefined,
    defaultThinkingOptionId,
  };
}

export async function resolveKimiCatalogModels({
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
    return models.map(withNormalizedKimiThinkingOptions);
  }
  const modelOption = findSelectConfigOption({ configOptions, category: "model" });
  if (!modelOption || !findSelectConfigOption({ configOptions, category: "thought_level" })) {
    return models.map(withNormalizedKimiThinkingOptions);
  }

  const resolved: AgentModelDefinition[] = [];
  for (const model of models) {
    try {
      const response = await runRequest(() =>
        connection.setSessionConfigOption({
          sessionId,
          configId: modelOption.id,
          value: model.id,
        }),
      );
      const modelConfigOptions = transformConfigOptions(response.configOptions ?? []);
      const derived = deriveSelectorOptions(modelConfigOptions, "thought_level");
      const { options: thinkingOptions, defaultThinkingOptionId } =
        normalizeKimiThinkingOptions(derived);
      resolved.push({
        ...model,
        thinkingOptions: thinkingOptions.length > 0 ? thinkingOptions : undefined,
        defaultThinkingOptionId,
      });
    } catch (error) {
      logger.warn(
        { modelId: model.id, error: toDiagnosticErrorMessage(error) },
        `${provider} catalog probe could not resolve thinking options for model "${model.id}"; keeping its default options`,
      );
      resolved.push(withNormalizedKimiThinkingOptions(model));
    }
  }
  return resolved;
}

export class KimiACPAgentClient extends GenericACPAgentClient {
  constructor(options: KimiACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      catalogModelResolver: resolveKimiCatalogModels,
    });
  }
}
