import type { ProviderUsage, ProviderUsageWindow } from "./types";

export function findActiveProviderUsage(
  providers: ProviderUsage[],
  activeProviderId: string | null | undefined,
): ProviderUsage | null {
  if (!activeProviderId) return null;
  const target = activeProviderId.toLowerCase();
  return providers.find((usage) => usage.providerId.toLowerCase() === target) ?? null;
}

function findSessionWindow(windows: ProviderUsageWindow[]): ProviderUsageWindow | null {
  return (
    windows.find(
      (window) =>
        window.id === "session" ||
        window.id === "five_hour" ||
        window.label.trim().toLowerCase() === "session",
    ) ?? null
  );
}

export function findActiveProviderSessionWindow(
  providers: ProviderUsage[],
  activeProviderId: string | null | undefined,
): ProviderUsageWindow | null {
  const usage = findActiveProviderUsage(providers, activeProviderId);
  return usage ? findSessionWindow(usage.windows) : null;
}
