import type { ClientSideConnection, SessionConfigOption } from "@agentclientprotocol/sdk";
import type { Logger } from "pino";

import type { AgentModelDefinition, AgentSelectOption } from "../agent-sdk-types.js";
import type { SessionStateResponse } from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

interface GrokACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

export interface GrokModelThinking {
  currentId: string | null;
  options: AgentSelectOption[];
}

const GROK_THOUGHT_LEVEL_CONFIG_ID = "thought_level";
const GROK_EFFORT_IDS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseGrokReasoningEffort(entry: unknown): AgentSelectOption | null {
  if (!isRecord(entry)) {
    return null;
  }
  const id = readString(entry.value) ?? readString(entry.id);
  if (!id) {
    return null;
  }
  const label = readString(entry.label) ?? id;
  const description = readString(entry.description) ?? undefined;
  return {
    id,
    label,
    description,
    isDefault: entry.default === true,
  };
}

function resolveGrokCurrentEffortId(
  options: AgentSelectOption[],
  currentId: string | null,
): string | null {
  if (currentId && options.some((option) => option.id === currentId)) {
    return currentId;
  }
  return options.find((option) => option.isDefault)?.id ?? options[0]?.id ?? null;
}

function withResolvedDefaults(
  options: AgentSelectOption[],
  currentId: string | null,
): GrokModelThinking {
  const resolvedCurrentId = resolveGrokCurrentEffortId(options, currentId);
  return {
    currentId: resolvedCurrentId,
    options: options.map((option) => ({
      ...option,
      isDefault: option.id === resolvedCurrentId,
    })),
  };
}

function extractThinkingFromModelMeta(meta: unknown): GrokModelThinking | null {
  if (!isRecord(meta) || meta.supportsReasoningEffort === false) {
    return null;
  }
  if (!Array.isArray(meta.reasoningEfforts)) {
    return null;
  }
  const options = meta.reasoningEfforts
    .map((entry) => parseGrokReasoningEffort(entry))
    .filter((option): option is AgentSelectOption => option !== null);
  if (options.length === 0) {
    return null;
  }
  return withResolvedDefaults(options, readString(meta.reasoningEffort));
}

function extractThinkingFromSessionConfig(meta: unknown): GrokModelThinking | null {
  if (!isRecord(meta)) {
    return null;
  }
  const sessionConfig = meta["x.ai/sessionConfig"];
  if (!isRecord(sessionConfig) || !Array.isArray(sessionConfig.options)) {
    return null;
  }

  const options: AgentSelectOption[] = [];
  let currentId: string | null = null;
  for (const entry of sessionConfig.options) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = readString(entry.id);
    const category = readString(entry.category);
    if (!id || !GROK_EFFORT_IDS.has(id)) {
      continue;
    }
    if (category !== "mode" && category !== "thought_level" && category !== "effort") {
      continue;
    }
    options.push({
      id,
      label: readString(entry.label) ?? id,
      description: readString(entry.description) ?? undefined,
      isDefault: entry.selected === true,
    });
    if (entry.selected === true) {
      currentId = id;
    }
  }
  if (options.length === 0) {
    return null;
  }
  return withResolvedDefaults(options, currentId);
}

export function extractGrokThinkingByModel(
  response: SessionStateResponse,
): Map<string, GrokModelThinking> {
  const thinkingByModelId = new Map<string, GrokModelThinking>();
  const availableModels = response.models?.availableModels ?? [];
  for (const model of availableModels) {
    const thinking = extractThinkingFromModelMeta(model._meta);
    if (thinking) {
      thinkingByModelId.set(model.modelId, thinking);
    }
  }
  if (thinkingByModelId.size > 0) {
    return thinkingByModelId;
  }

  const fallback = extractThinkingFromSessionConfig(response._meta);
  if (!fallback) {
    return thinkingByModelId;
  }
  for (const model of availableModels) {
    thinkingByModelId.set(model.modelId, fallback);
  }
  return thinkingByModelId;
}

function upsertThoughtLevelConfig(
  configOptions: SessionConfigOption[],
  thinking: GrokModelThinking,
): SessionConfigOption[] {
  const currentValue = thinking.currentId ?? thinking.options[0]?.id;
  if (!currentValue) {
    return configOptions;
  }

  const thoughtLevel: SessionConfigOption = {
    id: GROK_THOUGHT_LEVEL_CONFIG_ID,
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue,
    options: thinking.options.map((option) => ({
      value: option.id,
      name: option.label,
      description: option.description ?? null,
    })),
  };

  const withoutThoughtLevel = configOptions.filter(
    (option) => option.category !== "thought_level" && option.id !== GROK_THOUGHT_LEVEL_CONFIG_ID,
  );
  return [...withoutThoughtLevel, thoughtLevel];
}

export function transformGrokSessionResponse(
  response: SessionStateResponse,
  thinkingByModelId?: Map<string, GrokModelThinking>,
): SessionStateResponse {
  const extracted = extractGrokThinkingByModel(response);
  if (thinkingByModelId && extracted.size > 0) {
    thinkingByModelId.clear();
    for (const [modelId, thinking] of extracted) {
      thinkingByModelId.set(modelId, thinking);
    }
  }

  const currentModelId = response.models?.currentModelId;
  const currentThinking =
    (currentModelId ? extracted.get(currentModelId) : undefined) ??
    (currentModelId && thinkingByModelId ? thinkingByModelId.get(currentModelId) : undefined);
  if (!currentThinking || currentThinking.options.length === 0) {
    return response;
  }

  return {
    ...response,
    configOptions: upsertThoughtLevelConfig(response.configOptions ?? [], currentThinking),
  };
}

export function applyGrokThinkingToModels(
  models: AgentModelDefinition[],
  thinkingByModelId: ReadonlyMap<string, GrokModelThinking>,
): AgentModelDefinition[] {
  return models.map((model) => {
    const thinking = thinkingByModelId.get(model.id);
    if (!thinking || thinking.options.length === 0) {
      return model;
    }
    return {
      ...model,
      thinkingOptions: thinking.options,
      defaultThinkingOptionId: thinking.currentId ?? thinking.options[0]?.id,
    };
  });
}

// Grok ACP has no session modes. session/set_mode with an effort id is how it
// changes reasoning effort; it does not implement session/set_config_option.
export async function writeGrokThinkingOption(
  connection: ClientSideConnection,
  sessionId: string,
  thinkingOptionId: string,
): Promise<void> {
  await connection.setSessionMode({
    sessionId,
    modeId: thinkingOptionId,
  });
}

export class GrokACPAgentClient extends GenericACPAgentClient {
  constructor(options: GrokACPAgentClientOptions) {
    const thinkingByModelId = new Map<string, GrokModelThinking>();
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      sessionResponseTransformer: (response) =>
        transformGrokSessionResponse(response, thinkingByModelId),
      modelTransformer: (models) => applyGrokThinkingToModels(models, thinkingByModelId),
      thinkingOptionWriter: writeGrokThinkingOption,
    });
  }
}
