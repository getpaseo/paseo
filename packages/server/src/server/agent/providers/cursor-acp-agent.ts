import { zSessionConfigOption } from "@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import type { Logger } from "pino";
import { z } from "zod";

import type { AgentModelDefinition } from "../agent-sdk-types.js";
import {
  deriveSelectorOptions,
  type ACPCatalogModelResolverContext,
  type ACPConfigFeatureOption,
} from "./acp-agent.js";
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

const CursorModelCatalogSchema = z.object({
  models: z.array(
    z.object({
      value: z.string().min(1),
      name: z.string(),
      configOptions: z.array(zSessionConfigOption),
    }),
  ),
});

// Cursor model switches persist CLI preferences, even in a throwaway probe session.
// Its extension returns each model's parameter definitions without selecting it.
export async function resolveCursorCatalogModels({
  connection,
  models,
  provider,
  runRequest,
}: ACPCatalogModelResolverContext): Promise<AgentModelDefinition[]> {
  const catalog = await runRequest(() => fetchCursorModelCatalog(connection));
  const currentModelId = models.find((model) => model.isDefault)?.id;

  return catalog.models.map((model) => {
    const thinkingOptions = deriveSelectorOptions(model.configOptions, "thought_level");
    const defaultThinkingOptionId = thinkingOptions.find((option) => option.isDefault)?.id;
    return {
      provider,
      id: model.value,
      label: model.name,
      isDefault: model.value === currentModelId,
      thinkingOptions: thinkingOptions.length > 0 ? thinkingOptions : undefined,
      defaultThinkingOptionId,
    };
  });
}

async function fetchCursorModelCatalog(connection: ACPCatalogModelResolverContext["connection"]) {
  try {
    const response = await connection.extMethod("cursor/list_available_models", {});
    return CursorModelCatalogSchema.parse(response);
  } catch (error) {
    const extensionUnavailable =
      typeof error === "object" && error !== null && "code" in error && error.code === -32601;
    if (extensionUnavailable) {
      throw new Error(
        "Update Cursor CLI: this version does not support cursor/list_available_models.",
        { cause: error },
      );
    }
    throw error;
  }
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
      configFeatureOptions: [CURSOR_FAST_FEATURE_OPTION],
      catalogModelResolver: resolveCursorCatalogModels,
    });
  }
}
