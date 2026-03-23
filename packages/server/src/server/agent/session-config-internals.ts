const MANAGED_AGENT_ID = Symbol("paseo.managedAgentId");

type AgentSessionConfigInternals = {
  [MANAGED_AGENT_ID]?: string;
};

export function attachManagedAgentId<T extends object>(config: T, agentId?: string): T {
  if (typeof agentId !== "string" || agentId.trim().length === 0) {
    return config;
  }

  Object.defineProperty(config, MANAGED_AGENT_ID, {
    value: agentId,
    enumerable: false,
    configurable: true,
  });
  return config;
}

export function getManagedAgentId(config: object | null | undefined): string | undefined {
  if (!config) {
    return undefined;
  }
  const value = (config as AgentSessionConfigInternals)[MANAGED_AGENT_ID];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
