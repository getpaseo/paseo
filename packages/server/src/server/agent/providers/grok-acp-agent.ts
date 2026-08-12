import type {
  ClientSideConnection,
  SessionConfigOption,
  SessionModelState,
} from "@agentclientprotocol/sdk";
import type { Logger } from "pino";
import { z } from "zod";

import type { AgentModelDefinition, AgentSelectOption } from "../agent-sdk-types.js";
import type {
  ACPCatalogModelResolverContext,
  ACPProviderModelWriterContext,
  ACPProviderModelWriteResult,
  SessionStateResponse,
} from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

interface GrokACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

const GROK_REASONING_CONFIG_ID = "_paseo.grok.reasoning_effort";

const GrokReasoningEffortSchema = z
  .object({
    id: z.string().optional(),
    value: z.string().optional(),
    label: z.string().optional(),
    description: z.string().optional(),
    default: z.boolean().optional(),
  })
  .passthrough();

const GrokModelMetaSchema = z
  .object({
    supportsReasoningEffort: z.boolean().optional(),
    reasoningEffort: z.string().optional(),
    reasoningEfforts: z.array(GrokReasoningEffortSchema).optional(),
  })
  .passthrough();

type GrokReasoningEffort = z.infer<typeof GrokReasoningEffortSchema>;

function optionId(effort: GrokReasoningEffort): string | null {
  const id = effort.id?.trim() || effort.value?.trim();
  return id || null;
}

function reasoningOptions(meta: unknown): {
  options: AgentSelectOption[];
  defaultId: string | null;
} {
  const parsed = GrokModelMetaSchema.safeParse(meta);
  if (!parsed.success || parsed.data.supportsReasoningEffort === false) {
    return { options: [], defaultId: null };
  }

  const seen = new Set<string>();
  const efforts = (parsed.data.reasoningEfforts ?? []).flatMap((effort) => {
    const id = optionId(effort);
    if (!id || seen.has(id)) {
      return [];
    }
    seen.add(id);
    return [{ effort, id }];
  });
  const currentId = parsed.data.reasoningEffort?.trim();
  const defaultId =
    (currentId && seen.has(currentId) ? currentId : null) ??
    efforts.find(({ effort }) => effort.default === true)?.id ??
    efforts[0]?.id ??
    null;

  return {
    options: efforts.map(({ effort, id }) => ({
      id,
      label: effort.label?.trim() || id,
      description: effort.description?.trim() || undefined,
      isDefault: id === defaultId,
    })),
    defaultId,
  };
}

export function applyGrokReasoningOptions(
  models: AgentModelDefinition[],
  modelState: SessionModelState | null | undefined,
): AgentModelDefinition[] {
  const rawModels = new Map(
    modelState?.availableModels.map((model) => [model.modelId, model] as const) ?? [],
  );
  return models.map((model) => {
    const { options, defaultId } = reasoningOptions(rawModels.get(model.id)?._meta);
    if (options.length === 0 || !defaultId) {
      const {
        thinkingOptions: _thinkingOptions,
        defaultThinkingOptionId: _defaultId,
        ...plain
      } = model;
      return plain;
    }
    return {
      ...model,
      thinkingOptions: options,
      defaultThinkingOptionId: defaultId,
    };
  });
}

export async function resolveGrokCatalogModels({
  models,
  modelState,
  configOptions,
}: ACPCatalogModelResolverContext): Promise<AgentModelDefinition[]> {
  const standardThinkingOption = configOptions?.some(
    (option) => option.category === "thought_level" && option.id !== GROK_REASONING_CONFIG_ID,
  );
  if (standardThinkingOption) {
    return models;
  }
  return applyGrokReasoningOptions(models, modelState);
}

function grokThinkingConfigOption(
  modelState: SessionModelState | null | undefined,
): SessionConfigOption | null {
  const currentModel = modelState?.availableModels.find(
    (model) => model.modelId === modelState.currentModelId,
  );
  const { options, defaultId } = reasoningOptions(currentModel?._meta);
  if (options.length === 0 || !defaultId) {
    return null;
  }
  return {
    id: GROK_REASONING_CONFIG_ID,
    name: "Reasoning effort",
    category: "thought_level",
    type: "select",
    currentValue: defaultId,
    options: options.map((option) => ({
      value: option.id,
      name: option.label,
      description: option.description,
    })),
  };
}

export function transformGrokSessionResponse(response: SessionStateResponse): SessionStateResponse {
  const alreadyHasThinking = response.configOptions?.some(
    (option) => option.category === "thought_level",
  );
  if (alreadyHasThinking) {
    return response;
  }
  const thinkingOption = grokThinkingConfigOption(response.models);
  if (!thinkingOption) {
    return response;
  }
  return {
    ...response,
    configOptions: [...(response.configOptions ?? []), thinkingOption],
  };
}

export async function writeGrokThinkingOption(
  connection: ClientSideConnection,
  sessionId: string,
  thinkingOptionId: string,
): Promise<void> {
  // Grok exposes reasoning effort through ACP's mode endpoint.
  await connection.setSessionMode({ sessionId, modeId: thinkingOptionId });
}

export async function writeGrokModel({
  connection,
  sessionId,
  requestedModelId,
  currentThinkingOptionId,
  availableModel,
}: ACPProviderModelWriterContext): Promise<ACPProviderModelWriteResult> {
  const { options, defaultId } = reasoningOptions(availableModel._meta);
  const supportedEfforts = new Set(options.map((option) => option.id));
  const thinkingOptionId =
    (currentThinkingOptionId && supportedEfforts.has(currentThinkingOptionId)
      ? currentThinkingOptionId
      : null) ?? defaultId;

  await connection.unstable_setSessionModel({
    sessionId,
    modelId: requestedModelId,
    ...(thinkingOptionId ? { _meta: { reasoningEffort: thinkingOptionId } } : {}),
  });
  return {
    handled: true,
    currentModelId: requestedModelId,
    thinkingOptionId,
  };
}

export class GrokACPAgentClient extends GenericACPAgentClient {
  constructor(options: GrokACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      catalogModelResolver: resolveGrokCatalogModels,
      sessionResponseTransformer: transformGrokSessionResponse,
      providerModelWriter: writeGrokModel,
      thinkingOptionWriter: writeGrokThinkingOption,
    });
  }
}
