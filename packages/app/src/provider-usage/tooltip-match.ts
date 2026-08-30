import type { ProviderUsage } from "./types";

/** Resolves plan usage for the active agent; OMP uses its model-provider prefix. */
export function matchProviderUsage(
  providers: ProviderUsage[],
  activeProviderId: string | null | undefined,
  modelProviderId?: string | null,
): ProviderUsage | null {
  const activeProvider = activeProviderId?.toLowerCase();
  const modelProvider = modelProviderId?.toLowerCase();
  let target = activeProvider;
  if (activeProvider === "pi" || activeProvider === "omp") {
    target = modelProvider === "openai-codex" ? "codex" : modelProvider;
  }
  if (!target) return null;
  return providers.find((usage) => usage.providerId.toLowerCase() === target) ?? null;
}
