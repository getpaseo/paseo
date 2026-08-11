interface AgentProfileCapabilities {
  agentProfiles?: boolean;
  agentConfigApply?: boolean;
}

export function supportsAgentProfiles(features: AgentProfileCapabilities | undefined): boolean {
  return features?.agentProfiles === true && features.agentConfigApply === true;
}
