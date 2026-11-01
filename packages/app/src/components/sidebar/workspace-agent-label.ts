import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { resolveProviderLabel } from "@/utils/provider-definitions";

/** "Claude Code · Opus 5.5": the provider's label, then the model's, falling back to the raw ids. */
export function formatWorkspaceAgentLabel(
  provider: string,
  model: string | null,
  snapshotEntries: ProviderSnapshotEntry[] | undefined,
): string {
  const providerLabel = resolveProviderLabel(provider, snapshotEntries);
  if (!model) return providerLabel;
  const models = snapshotEntries?.find((entry) => entry.provider === provider)?.models;
  const definition = models?.find((entry) => entry.id === model || entry.aliases?.includes(model));
  return `${providerLabel} · ${definition?.label ?? model}`;
}
