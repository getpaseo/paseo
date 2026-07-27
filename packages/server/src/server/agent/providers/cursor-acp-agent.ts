import type { Logger } from "pino";

import type { AgentPersistenceHandle, ProviderCatalog } from "../agent-sdk-types.js";
import type { ACPConfigFeatureOption } from "./acp-agent.js";
import {
  createCursorContextUsageResolver,
  transformCursorModelDefinition,
} from "./cursor-context-usage.js";
import { deleteCursorNativeSession } from "./cursor-delete-native-session.js";
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
  // Match by id only — Cursor has used both bare and `model_config` categories.
  label: "Context",
  description: "Cursor context length",
  tooltip: "Select context window length",
  icon: "gauge",
};

export class CursorACPAgentClient extends GenericACPAgentClient {
  private readonly contextWindowMaxTokensByModel: Map<string, number>;

  constructor(options: CursorACPAgentClientOptions) {
    const contextWindowMaxTokensByModel = new Map<string, number>();
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
      configFeatureOptions: [CURSOR_CONTEXT_FEATURE_OPTION, CURSOR_FAST_FEATURE_OPTION],
      modelDefinitionTransformer: transformCursorModelDefinition,
      contextUsageResolver: createCursorContextUsageResolver({
        env: options.env,
        resolveContextWindowMaxTokens: (modelId) =>
          modelId ? contextWindowMaxTokensByModel.get(modelId) : undefined,
      }),
    });
    this.contextWindowMaxTokensByModel = contextWindowMaxTokensByModel;
  }

  protected override async deleteLocalNativeSession(handle: AgentPersistenceHandle): Promise<void> {
    await deleteCursorNativeSession({
      sessionId: handle.nativeHandle ?? handle.sessionId,
    });
  }

  override async fetchCatalog(
    options: Parameters<GenericACPAgentClient["fetchCatalog"]>[0],
  ): Promise<ProviderCatalog> {
    const catalog = await super.fetchCatalog(options);
    for (const model of catalog.models) {
      if (model.contextWindowMaxTokens) {
        this.contextWindowMaxTokensByModel.set(model.id, model.contextWindowMaxTokens);
      }
    }
    return catalog;
  }
}
