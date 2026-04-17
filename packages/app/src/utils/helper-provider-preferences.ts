import type { AgentProvider, ProviderSnapshotEntry } from "@server/server/agent/agent-sdk-types";

export interface HelperProviderPreference {
  provider: AgentProvider;
  model?: string | null;
}

function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeHelperProviderPreference(
  value: unknown,
): HelperProviderPreference | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as { provider?: unknown; model?: unknown };
  if (!isAgentProvider(candidate.provider)) {
    return null;
  }

  const model =
    typeof candidate.model === "string" && candidate.model.trim().length > 0
      ? candidate.model.trim()
      : null;

  return {
    provider: candidate.provider,
    model,
  };
}

function normalizeModelForEntry(
  model: string | null | undefined,
  entry: ProviderSnapshotEntry | undefined,
): string | null {
  if (!entry || !model) {
    return null;
  }

  return entry.models?.some((candidate) => candidate.id === model) ? model : null;
}

export function normalizeHelperProviderPreferences(
  values: unknown,
): HelperProviderPreference[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const seen = new Set<AgentProvider>();
  const result: HelperProviderPreference[] = [];

  for (const value of values) {
    const normalized = normalizeHelperProviderPreference(value);
    if (!normalized || seen.has(normalized.provider)) {
      continue;
    }
    seen.add(normalized.provider);
    result.push(normalized);
  }

  return result;
}

export function resolveHelperProviderPreferences(options: {
  entries: ProviderSnapshotEntry[] | undefined;
  savedPreferences: HelperProviderPreference[] | undefined;
}): HelperProviderPreference[] {
  const saved = normalizeHelperProviderPreferences(options.savedPreferences ?? []);
  const readyEntries = (options.entries ?? []).filter((entry) => entry.status === "ready");
  const entriesByProvider = new Map(readyEntries.map((entry) => [entry.provider, entry]));

  if (readyEntries.length === 0) {
    return saved;
  }

  const seen = new Set<AgentProvider>();
  const result: HelperProviderPreference[] = [];

  for (const preference of saved) {
    const entry = entriesByProvider.get(preference.provider);
    if (!entry || seen.has(preference.provider)) {
      continue;
    }

    seen.add(preference.provider);
    result.push({
      provider: preference.provider,
      model: normalizeModelForEntry(preference.model, entry),
    });
  }

  for (const entry of readyEntries) {
    if (seen.has(entry.provider)) {
      continue;
    }

    seen.add(entry.provider);
    result.push({
      provider: entry.provider,
      model: null,
    });
  }

  return result;
}
