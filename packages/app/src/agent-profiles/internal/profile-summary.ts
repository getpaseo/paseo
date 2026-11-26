import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { formatAgentModeLabel, formatThinkingOptionLabel } from "@/agent-controls/labels";

export interface AgentProfileTag {
  id: string;
  label: string;
}

export interface ShortModelLabel {
  prefix: string | null;
  name: string;
}

/**
 * Splits slash-qualified routing IDs (e.g. `openrouter/moonshotai/kimi-k3.1-pro`)
 * into a quiet prefix and the model's short name so dense roster rows stay readable.
 */
export function formatShortModelLabel(modelIdOrLabel: string): ShortModelLabel {
  const trimmed = modelIdOrLabel.trim();
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash <= 0 || lastSlash >= trimmed.length - 1) {
    return { prefix: null, name: trimmed };
  }
  return {
    prefix: trimmed.slice(0, lastSlash + 1),
    name: trimmed.slice(lastSlash + 1),
  };
}

export interface AgentProfileRosterSummary {
  providerLabel: string;
  modelLabel: string | null;
  modelPrefix: string | null;
  runtimeDetails: string[];
  allTags: AgentProfileTag[];
}

export function buildAgentProfileRosterSummary(input: {
  profile: AgentProfile;
  entries: readonly ProviderSnapshotEntry[] | undefined;
  formatFeatureCount: (count: number) => string;
}): AgentProfileRosterSummary {
  const allTags = buildAgentProfileTags(input);
  const providerLabel =
    allTags.find((tag) => tag.id === "provider")?.label ?? input.profile.provider;
  const rawModel = allTags.find((tag) => tag.id === "model")?.label ?? null;
  const shortModel = rawModel ? formatShortModelLabel(rawModel) : null;
  const runtimeDetails = allTags.filter((tag) => tag.id !== "model").map((tag) => tag.label);
  return {
    providerLabel,
    modelLabel: shortModel?.name ?? null,
    modelPrefix: shortModel?.prefix ?? null,
    runtimeDetails,
    allTags,
  };
}

function findEntry(
  entries: readonly ProviderSnapshotEntry[],
  provider: string,
): ProviderSnapshotEntry | null {
  return entries.find((entry) => entry.provider === provider) ?? null;
}

/**
 * The one-line résumé of a profile in the settings list. Every label falls back
 * to the stored id: a row must stay readable on a host whose provider catalog
 * is offline, or that no longer ships the model the profile names.
 */
export function buildAgentProfileTags(input: {
  profile: AgentProfile;
  entries: readonly ProviderSnapshotEntry[] | undefined;
  formatFeatureCount: (count: number) => string;
}): AgentProfileTag[] {
  const entries = input.entries ?? [];
  const entry = findEntry(entries, input.profile.provider);
  const tags: AgentProfileTag[] = [
    { id: "provider", label: entry?.label ?? input.profile.provider },
  ];

  const modelId = input.profile.model?.trim();
  if (modelId) {
    const model = entry?.models?.find((candidate) => candidate.id === modelId);
    tags.push({ id: "model", label: model?.label ?? modelId });
  }

  const modeId = input.profile.modeId?.trim();
  if (modeId) {
    const mode = entry?.modes?.find((candidate) => candidate.id === modeId);
    tags.push({ id: "mode", label: mode ? formatAgentModeLabel(mode) : modeId });
  }

  const thinkingOptionId = input.profile.thinkingOptionId?.trim();
  if (thinkingOptionId) {
    tags.push({ id: "thinking", label: formatThinkingOptionLabel({ id: thinkingOptionId }) });
  }

  const featureCount = Object.keys(input.profile.options ?? {}).length;
  if (featureCount > 0) {
    tags.push({ id: "features", label: input.formatFeatureCount(featureCount) });
  }

  return tags;
}
