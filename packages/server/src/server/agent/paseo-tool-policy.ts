import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";

interface ProviderPaseoToolSettings {
  paseoTools?: ProviderPaseoToolsPolicy;
}

export function resolvePaseoToolPolicy(
  providerId: string,
  providerSettings: Readonly<Record<string, ProviderPaseoToolSettings>> | undefined,
): ProviderPaseoToolsPolicy | undefined {
  return providerSettings?.[providerId]?.paseoTools;
}

export function isPaseoToolEnabled(
  policy: ProviderPaseoToolsPolicy | undefined,
  toolName: string,
): boolean {
  if (toolName === "speak") {
    return true;
  }
  if (!isPaseoToolPolicyEnabled(policy)) {
    return false;
  }
  return !policy?.disabledTools?.includes(toolName);
}

export function isPaseoToolPolicyEnabled(policy: ProviderPaseoToolsPolicy | undefined): boolean {
  return policy?.enabled !== false;
}

/**
 * An agent's own `paseoTools` over its provider's. Either can turn Paseo's tools off and their
 * disabled tools add up, so an agent can only narrow what its provider allows.
 */
export function narrowPaseoToolPolicy(
  provider: ProviderPaseoToolsPolicy | undefined,
  agent: ProviderPaseoToolsPolicy | undefined,
): ProviderPaseoToolsPolicy | undefined {
  if (!agent) return provider;
  const disabledTools = [
    ...new Set([...(provider?.disabledTools ?? []), ...(agent.disabledTools ?? [])]),
  ];
  return {
    enabled: isPaseoToolPolicyEnabled(provider) && isPaseoToolPolicyEnabled(agent),
    ...(disabledTools.length > 0 ? { disabledTools } : {}),
  };
}
