import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";

type ProviderEntry = MutableDaemonConfig["metadataGeneration"]["providers"][number];

export interface SuggestionModelChoice {
  provider: string;
  model: string;
}

// Null means Automatic: an empty list makes suggestions use the shared one. A choice
// replaces only the first entry, so fallbacks configured by hand survive.
export function buildSuggestionModelPatch(
  choice: SuggestionModelChoice | null,
  current: readonly ProviderEntry[] | undefined,
): MutableDaemonConfigPatch {
  const providers = choice
    ? [
        { provider: choice.provider, ...(choice.model ? { model: choice.model } : {}) },
        ...(current?.slice(1) ?? []),
      ]
    : [];
  return { metadataGeneration: { promptSuggestions: { providers } } };
}
