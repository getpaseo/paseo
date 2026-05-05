export const TEST_HOST_LABEL = "localhost";

export const TEST_PROVIDER_PREFERENCES = {
  claude: { model: "haiku" },
  codex: { model: "gpt-5.4-mini", thinkingOptionId: "low" },
} as const;

export function buildDirectTcpConnection(endpoint: string) {
  return {
    id: `direct:${endpoint}`,
    type: "directTcp" as const,
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
} as const;

export function buildCreateAgentPreferences(serverId: string) {
  return {
    serverId,
    provider: "mock" as const,
    providerPreferences: TEST_MOCK_PROVIDER_PREFERENCES,
  };
}
