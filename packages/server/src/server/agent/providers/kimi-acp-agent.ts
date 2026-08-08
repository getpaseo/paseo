import type { Logger } from "pino";

import type { AgentModelDefinition } from "../agent-sdk-types.js";
import {
  type ACPCatalogModelResolverContext,
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
 * read back its real thinking options, rather than spawning a probe per model. Skipped
 * entirely when the provider reports one model or no thinking picker, so a misbehaving ACP
 * that only advertises a single model pays no extra round trips.
 *
 * This lives on the Kimi client, not the base ACP adapter: only Kimi needs the extra
 * `setSessionConfigOption` round trips, so no other ACP provider risks a slow or
 * nonconforming agent stalling its catalog probe on model switching.
 */
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
    return models;
  }
  const modelOption = findSelectConfigOption({ configOptions, category: "model" });
  if (!modelOption || !findSelectConfigOption({ configOptions, category: "thought_level" })) {
    return models;
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
      const thinkingOptions = deriveSelectorOptions(modelConfigOptions, "thought_level");
      resolved.push({
        ...model,
        thinkingOptions: thinkingOptions.length > 0 ? thinkingOptions : undefined,
        defaultThinkingOptionId:
          thinkingOptions.find((option) => option.isDefault)?.id ?? undefined,
      });
    } catch (error) {
      logger.warn(
        { modelId: model.id, error: toDiagnosticErrorMessage(error) },
        `${provider} catalog probe could not resolve thinking options for model "${model.id}"; keeping its default options`,
      );
      resolved.push(model);
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
