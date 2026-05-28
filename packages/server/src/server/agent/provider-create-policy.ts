import type {
  AgentFeature,
  AgentMode,
  AgentProvider,
  AgentSessionConfig,
} from "./agent-sdk-types.js";
import { resolveAndValidateCreateAgentMode } from "./create-agent-mode.js";

export interface ProviderCreateParent {
  provider: AgentProvider;
  modeId: string | null;
  isUnattended: boolean;
}

export interface ProviderCreatePolicyInput {
  provider: AgentProvider;
  requestedMode: string | undefined;
  featureValues: Record<string, unknown> | undefined;
  parent: ProviderCreateParent | null;
  availableModes: AgentMode[];
}

export interface ProviderCreatePolicyResult {
  modeId: string | undefined;
  featureValues: Record<string, unknown> | undefined;
}

export interface ProviderUnattendedInput {
  modeId: string | null;
  config: AgentSessionConfig;
  features?: AgentFeature[];
  availableModes: AgentMode[];
}

export interface ProviderCreatePolicy {
  resolve(input: ProviderCreatePolicyInput): ProviderCreatePolicyResult;
  isUnattended(input: ProviderUnattendedInput): boolean;
}

interface AgentModeWithPolicy extends AgentMode {
  isUnattended?: boolean;
}

export const DEFAULT_PROVIDER_CREATE_POLICY: ProviderCreatePolicy = {
  resolve(input) {
    return {
      modeId: resolveAndValidateCreateAgentMode({
        requestedMode: input.requestedMode,
        targetProvider: input.provider,
        parent: input.parent,
        availableModes: input.availableModes.map((mode) => mode.id),
        targetUnattendedMode: input.availableModes.find(isUnattendedMode)?.id,
      }),
      featureValues: input.featureValues,
    };
  },
  isUnattended(input) {
    if (input.modeId === null) {
      return false;
    }
    return input.availableModes.some((mode) => mode.id === input.modeId && isUnattendedMode(mode));
  },
};

function isUnattendedMode(mode: AgentMode): boolean {
  return (mode as AgentModeWithPolicy).isUnattended === true;
}
