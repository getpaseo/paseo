import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import type { ProviderUsage } from "./types";

export function getHiddenProviderIds(config: MutableDaemonConfig | null): string[] {
  return Array.from(new Set(config?.providerUsage?.hiddenProviders ?? []));
}

// Emit a single-provider visibility delta rather than a full-array snapshot. The server merges
// this against its authoritative hidden-provider set, so a client never has to reason about a
// stale local snapshot — concurrent clients toggling different providers can no longer silently
// undo each other (lost update).
export function createProviderVisibilityPatch(input: {
  providerId: string;
  visible: boolean;
}): MutableDaemonConfigPatch {
  return {
    providerUsage: input.visible
      ? { showProviders: [input.providerId] }
      : { hideProviders: [input.providerId] },
  };
}

export function filterVisibleProviders(
  providers: readonly ProviderUsage[],
  hiddenProviderIds: readonly string[],
): ProviderUsage[] {
  const hiddenProviders = new Set(hiddenProviderIds);
  return providers.filter((provider) => !hiddenProviders.has(provider.providerId));
}
