import type { ProviderUsage } from "./types";

/**
 * The upstream provider a model routes through, taken from the `upstream/model`
 * identifier every multi-provider agent uses (OpenCode, ACP, and Codex profiles).
 * Returns null when the id has no usable prefix.
 */
function upstreamProviderOf(model: string | null | undefined): string | null {
  if (typeof model !== "string") return null;
  const slash = model.indexOf("/");
  if (slash <= 0) return null;
  const prefix = model.slice(0, slash).trim();
  return prefix.length > 0 ? prefix : null;
}

/**
 * Finds the provider usage entry for the active agent. Agents address the model
 * through a Paseo provider (e.g. `opencode`, `opencode-acp`) that is distinct from
 * the usage fetcher (e.g. `synthetic`), so match the Paseo provider id first and the
 * model's upstream provider prefix second. The first candidate that matches wins.
 */
export function resolveProviderUsage(
  providers: readonly ProviderUsage[],
  providerId: string | null | undefined,
  model: string | null | undefined,
): ProviderUsage | null {
  const candidates: string[] = [];
  if (typeof providerId === "string" && providerId.trim().length > 0) {
    candidates.push(providerId.trim().toLowerCase());
  }
  const upstream = upstreamProviderOf(model);
  if (upstream) {
    const normalized = upstream.toLowerCase();
    if (!candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  }
  if (candidates.length === 0) return null;

  const byId = new Map<string, ProviderUsage>();
  for (const usage of providers) {
    byId.set(usage.providerId.toLowerCase(), usage);
  }
  for (const candidate of candidates) {
    const match = byId.get(candidate);
    if (match) return match;
  }
  return null;
}
