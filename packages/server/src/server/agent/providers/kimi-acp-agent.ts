import type { Logger } from "pino";

import type { AgentModelDefinition } from "../agent-sdk-types.js";
import {
  type ACPCatalogModelResolverContext,
  deriveSelectorOptions,
  findSelectConfigOption,
  type ACPProviderModeWriteResult,
  type ACPProviderModeWriterContext,
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

// Kimi exposes three internal permission modes: yolo, manual, auto.
// The Kimi "yolo" mode auto-approves tool calls but still allows the
// model to ask questions. The "auto" mode is the truly autonomous mode
// that prevents operator questions. Paseo's "yolo" mode means "no
// operator questions for pre-approved work", so we map it to Kimi
// "auto".
const KIMI_PASEO_TO_PROVIDER_MODE: Record<string, string> = {
  yolo: "auto",
  auto: "auto",
  plan: "plan",
};

// Map a Paseo UI mode id to the provider mode id that Kimi will actually
// receive over ACP. Paseo "yolo" and "auto" both map to Kimi "auto".
export function mapKimiPaseoToProviderMode(paseoModeId: string): string | null {
  return KIMI_PASEO_TO_PROVIDER_MODE[paseoModeId] ?? null;
}

// Map a Kimi-reported mode id back to the Paseo UI mode id.
//
// The only non-identity mapping is the auto → yolo echo: when the user
// selects Paseo "yolo" we send Kimi "auto", and Kimi later echoes "auto" in
// current_mode_update. In that case we keep showing "yolo" to the user. For
// every other combination we preserve the provider's own id, so a genuine
// Paseo "auto" selection (which also maps to Kimi "auto") stays "auto" in
// the UI instead of being falsely renamed to "yolo".
export function kimiProviderToPaseoMode(
  providerModeId: string,
  currentPaseoModeId: string | null | undefined,
): string | null {
  if (providerModeId === "auto" && currentPaseoModeId === "yolo") {
    return "yolo";
  }
  if (providerModeId === "yolo" || providerModeId === "auto" || providerModeId === "plan") {
    return providerModeId;
  }
  return providerModeId;
}

export class KimiACPAgentClient extends GenericACPAgentClient {
  constructor(options: KimiACPAgentClientOptions) {
    super({
      ...options,
      catalogModelResolver: resolveKimiCatalogModels,
      modeIdTransformer: (providerModeId, currentModeId) =>
        kimiProviderToPaseoMode(providerModeId, currentModeId),
      providerModeMapper: (paseoModeId) => mapKimiPaseoToProviderMode(paseoModeId),
      providerModeWriter: (context) => writeKimiMode(context),
    });
  }
}

export async function writeKimiMode(
  context: ACPProviderModeWriterContext,
): Promise<ACPProviderModeWriteResult> {
  const providerModeId = KIMI_PASEO_TO_PROVIDER_MODE[context.requestedModeId];
  if (!providerModeId) {
    return { handled: false };
  }

  // If the provider already exposes this mode under the same id, let the
  // default ACP path handle the switch so we do not bypass any config-option
  // bookkeeping unnecessarily.
  if (
    context.selection.availableMode?.id === providerModeId ||
    context.selection.configChoice?.value === providerModeId
  ) {
    return { handled: false };
  }

  await context.connection.setSessionMode({
    sessionId: context.sessionId,
    modeId: providerModeId,
  });

  // Report the Paseo mode id back so the UI stays aligned with the user's
  // selection, even though Kimi is operating in a different internal mode.
  return { handled: true, currentModeId: context.requestedModeId };
}
