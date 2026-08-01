import { PASEO_TOOL_MANIFEST } from "@getpaseo/protocol/paseo-tool-manifest";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";

interface ProviderPaseoToolSettings {
  paseoTools?: ProviderPaseoToolsPolicy;
}

export const PASEO_TOOL_NAMES: ReadonlySet<string> = new Set(
  PASEO_TOOL_MANIFEST.map((tool) => tool.id),
);

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
  if (PASEO_TOOL_NAMES.size > 0 && !PASEO_TOOL_NAMES.has(toolName)) {
    return true;
  }
  return !policy?.disabledTools?.includes(toolName);
}

export function isPaseoToolPolicyEnabled(policy: ProviderPaseoToolsPolicy | undefined): boolean {
  return policy?.enabled !== false;
}
