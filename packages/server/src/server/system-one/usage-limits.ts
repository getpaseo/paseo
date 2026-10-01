import type { ProviderUsage } from "@getpaseo/protocol/messages";

export interface ProviderLimit {
  /** When the last exhausted window of this provider resets; null when the provider does not say. */
  resetsAt: string | null;
}

function isExhausted(window: { usedPct?: number | null; remainingPct?: number | null }): boolean {
  return (window.usedPct ?? 0) >= 100 || window.remainingPct === 0;
}

/**
 * Providers that are at a limit right now, keyed by provider (profile) id. A provider is usable
 * again once every exhausted window has reset, so the latest reset wins.
 */
export function limitedProviders(
  usage: readonly ProviderUsage[] | null | undefined,
  now: number = Date.now(),
): Map<string, ProviderLimit> {
  const limited = new Map<string, ProviderLimit>();
  for (const provider of usage ?? []) {
    const exhausted = provider.windows.filter(
      (w) => isExhausted(w) && (!w.resetsAt || Date.parse(w.resetsAt) > now),
    );
    if (exhausted.length === 0) continue;
    const resets = exhausted.map((w) => (w.resetsAt ? Date.parse(w.resetsAt) : null));
    const resetsAt = resets.some((r) => r === null)
      ? null
      : new Date(Math.max(...(resets as number[]))).toISOString();
    limited.set(provider.providerId, { resetsAt });
  }
  return limited;
}

/** The earliest moment any of the given providers is usable again, or null if none says. */
export function earliestReset(
  providers: readonly string[],
  limited: Map<string, ProviderLimit>,
): string | null {
  const times = providers
    .map((id) => limited.get(id)?.resetsAt)
    .filter((t): t is string => typeof t === "string")
    .map((t) => Date.parse(t));
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}
