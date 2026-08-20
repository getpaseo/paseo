import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
  FetchCatalogOptions,
  ProviderRefreshContext,
  ProviderCatalog,
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

export class MockSlowProviderClient implements AgentClient {
  readonly provider: AgentProvider = MOCK_SLOW_PROVIDER_ID;
  readonly capabilities = CAPABILITIES;

  async isAvailable(): Promise<boolean> {
    return process.env.PASEO_ENABLE_MOCK_SLOW === "true";
  }

  async fetchCatalog(
    _options: FetchCatalogOptions,
    context?: ProviderRefreshContext,
  ): Promise<ProviderCatalog> {
    return await (context?.runActivity(
      "mock.catalog",
      () =>
        new Promise<ProviderCatalog>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), {
            once: true,
          });
        }),
    ) ?? new Promise<ProviderCatalog>(() => {}));
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    return {
      diagnostic:
        "Mock slow provider: dev-only. fetchCatalog() never resolves so the snapshot manager will time out.",
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
