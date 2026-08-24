import type {
  FormPreferences,
  ProviderPreferences,
} from "../../../src/create-agent-preferences/preferences";

export const TEST_HOST_LABEL = "localhost";

export const TEST_PROVIDER_PREFERENCES = {
  claude: { model: "haiku" },
  codex: { model: "gpt-5.4-mini", thinkingByModel: { "gpt-5.4-mini": "low" } },
} satisfies Record<string, ProviderPreferences>;

export function buildDirectTcpConnection(endpoint: string): {
  id: string;
  type: "directTcp";
  endpoint: string;
} {
  return {
    id: `direct:${endpoint}`,
    type: "directTcp",
    endpoint,
  };
}

export function buildSeededHost(input: {
  serverId: string;
  endpoint: string;
  label?: string;
  nowIso: string;
}) {
  const connection = buildDirectTcpConnection(input.endpoint);
  return {
    serverId: input.serverId,
    label: input.label ?? TEST_HOST_LABEL,
    connections: [connection],
    preferredConnectionId: connection.id,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  };
}

export const TEST_MOCK_PROVIDER_PREFERENCES = {
  ...TEST_PROVIDER_PREFERENCES,
  mock: { model: "ten-second-stream" },
} satisfies Record<string, ProviderPreferences>;

export function buildCreateAgentPreferences() {
  return {
    provider: "mock",
    providerPreferences: TEST_MOCK_PROVIDER_PREFERENCES,
  } satisfies FormPreferences;
}
