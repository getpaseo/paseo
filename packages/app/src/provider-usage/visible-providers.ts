import type { ProviderUsage } from "./types";

export function selectVisibleProviderUsage(input: {
  providers: readonly ProviderUsage[];
  enabledProviderIds?: ReadonlySet<string> | null;
}): ProviderUsage[] {
  return input.providers.filter((provider) => {
    if (provider.status === "unavailable") {
      return false;
    }
    if (
      input.enabledProviderIds &&
      !input.enabledProviderIds.has(provider.providerId.toLowerCase())
    ) {
      return false;
    }
    return true;
  });
}

export function enabledProviderIdsFromSnapshot(
  entries:
    | ReadonlyArray<{
        provider: string;
        enabled: boolean;
      }>
    | null
    | undefined,
): Set<string> | null {
  if (!entries) {
    return null;
  }
  return new Set(
    entries.filter((entry) => entry.enabled).map((entry) => entry.provider.toLowerCase()),
  );
}
