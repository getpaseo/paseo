import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import type { ProviderUsage } from "./types";

export function getHiddenProviderIds(config: MutableDaemonConfig | null): string[] {
  return Array.from(new Set(config?.providerUsage?.hiddenProviders ?? []));
}

export function createProviderVisibilityPatch(input: {
  hiddenProviderIds: readonly string[];
  providerId: string;
  visible: boolean;
}): MutableDaemonConfigPatch {
  const hiddenProviders = new Set(input.hiddenProviderIds);
  if (input.visible) {
    hiddenProviders.delete(input.providerId);
  } else {
    hiddenProviders.add(input.providerId);
  }
  return { providerUsage: { hiddenProviders: Array.from(hiddenProviders).sort() } };
}

export function filterVisibleProviders(
  providers: readonly ProviderUsage[],
  hiddenProviderIds: readonly string[],
): ProviderUsage[] {
  const hiddenProviders = new Set(hiddenProviderIds);
  return providers.filter((provider) => !hiddenProviders.has(provider.providerId));
}
