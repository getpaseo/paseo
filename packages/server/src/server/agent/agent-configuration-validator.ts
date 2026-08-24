import type { ProviderOptions } from "@getpaseo/protocol/agent-types";
import type { HubExecutionAgentValidationIssue } from "@getpaseo/protocol/messages";

import type { ProviderSnapshotEntry } from "./agent-sdk-types.js";
import { filterSelectableAgentModels } from "./agent-sdk-types.js";
import { ProviderOptionsValidationError } from "./provider-options.js";

export interface AgentConfigurationValidationInput {
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  providerOptions?: ProviderOptions;
}

interface AgentConfigurationValidationContext {
  input: AgentConfigurationValidationInput;
  provider: ProviderSnapshotEntry;
  validateOptions(options: ProviderOptions | undefined): ProviderOptions | undefined;
}

export function validateAgentConfigurationAgainstProvider({
  input,
  provider,
  validateOptions,
}: AgentConfigurationValidationContext): HubExecutionAgentValidationIssue[] {
  const issues: HubExecutionAgentValidationIssue[] = [];
  const models = filterSelectableAgentModels(provider.models);
  const requestedModel = input.model;
  const selectedModel = requestedModel
    ? models.find((model) => model.id === requestedModel || model.aliases?.includes(requestedModel))
    : (models.find((model) => model.isDefault) ?? models[0]);

  if (requestedModel && !selectedModel) {
    issues.push({
      path: ["model"],
      message: `Model '${requestedModel}' is not available for provider '${input.provider}'`,
    });
  }
  if (input.modeId && !provider.modes?.some((mode) => mode.id === input.modeId)) {
    issues.push({
      path: ["modeId"],
      message: `Mode '${input.modeId}' is not available for provider '${input.provider}'`,
    });
  }
  if (
    input.thinkingOptionId &&
    !selectedModel?.thinkingOptions?.some((option) => option.id === input.thinkingOptionId)
  ) {
    issues.push({
      path: ["thinkingOptionId"],
      message: `Thinking option '${input.thinkingOptionId}' is not available for provider '${input.provider}'`,
    });
  }

  try {
    validateOptions(input.providerOptions);
  } catch (error) {
    if (!(error instanceof ProviderOptionsValidationError)) throw error;
    issues.push(
      ...error.issues.map((issue) => ({
        path: ["providerOptions", ...issue.path],
        message: issue.message,
      })),
    );
  }

  return issues;
}
