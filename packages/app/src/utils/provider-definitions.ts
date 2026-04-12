import type { ProviderSnapshotEntry, AgentProvider } from "@server/server/agent/agent-sdk-types";
import {
  AGENT_PROVIDER_DEFINITIONS,
  type AgentModeColorTier,
  type AgentModeIcon,
  type AgentProviderDefinition,
  type AgentProviderModeDefinition,
} from "@server/server/agent/provider-manifest";

const STATIC_PROVIDER_DEFINITION_MAP = new Map<AgentProvider, AgentProviderDefinition>(
  AGENT_PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition]),
);

function buildProviderModes(args: {
  entry: ProviderSnapshotEntry;
  staticDefinition?: AgentProviderDefinition;
}): AgentProviderModeDefinition[] {
  const { entry, staticDefinition } = args;
  const entryModes = entry.modes ?? staticDefinition?.modes ?? [];

  return entryModes.map((mode) => {
    const staticMode = staticDefinition?.modes.find((candidate) => candidate.id === mode.id);
    return {
      ...mode,
      icon: (staticMode?.icon ?? "ShieldCheck") as AgentModeIcon,
      colorTier: (staticMode?.colorTier ?? "moderate") as AgentModeColorTier,
    };
  });
}

export function buildProviderDefinitions(
  snapshotEntries: ProviderSnapshotEntry[] | undefined,
): AgentProviderDefinition[] {
  if (!snapshotEntries?.length) {
    return AGENT_PROVIDER_DEFINITIONS;
  }

  return snapshotEntries.map((entry) => {
    const staticDefinition = STATIC_PROVIDER_DEFINITION_MAP.get(entry.provider);

    return {
      id: entry.provider,
      label: entry.label ?? staticDefinition?.label ?? entry.provider,
      description: entry.description ?? staticDefinition?.description ?? "",
      defaultModeId: entry.defaultModeId ?? staticDefinition?.defaultModeId ?? null,
      modes: buildProviderModes({ entry, staticDefinition }),
      voice: staticDefinition?.voice,
    };
  });
}

export function resolveProviderLabel(
  provider: string,
  snapshotEntries: ProviderSnapshotEntry[] | undefined,
): string {
  return (
    snapshotEntries?.find((entry) => entry.provider === provider)?.label ??
    STATIC_PROVIDER_DEFINITION_MAP.get(provider)?.label ??
    provider
  );
}

export function resolveProviderDefinition(
  provider: string,
  snapshotEntries: ProviderSnapshotEntry[] | undefined,
): AgentProviderDefinition | undefined {
  return (
    buildProviderDefinitions(snapshotEntries).find((definition) => definition.id === provider) ??
    STATIC_PROVIDER_DEFINITION_MAP.get(provider)
  );
}
