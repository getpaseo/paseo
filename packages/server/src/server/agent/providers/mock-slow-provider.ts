import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentLaunchContext,
  AgentMode,
  AgentModelDefinition,
  AgentPersistenceHandle,
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
  ListModelsOptions,
  ListModesOptions,
} from "../agent-sdk-types.js";

export const MOCK_SLOW_PROVIDER_ID = "mock-slow";

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

function neverResolves<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

export class MockSlowProviderClient implements AgentClient {
  readonly provider: AgentProvider = MOCK_SLOW_PROVIDER_ID;
  readonly capabilities = CAPABILITIES;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  listModels(_options: ListModelsOptions): Promise<AgentModelDefinition[]> {
    return neverResolves<AgentModelDefinition[]>();
  }

  listModes(_options: ListModesOptions): Promise<AgentMode[]> {
    return neverResolves<AgentMode[]>();
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    return {
      diagnostic:
        "Mock slow provider: dev-only. listModels() never resolves so the snapshot manager will time out.",
    };
  }

  createSession(
    _config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    throw new Error("Mock slow provider is dev-only; sessions are not supported.");
  }

  resumeSession(
    _handle: AgentPersistenceHandle,
    _overrides?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    throw new Error("Mock slow provider is dev-only; sessions are not supported.");
  }
}
