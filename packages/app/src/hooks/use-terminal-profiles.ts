import { useMemo } from "react";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import {
  DEFAULT_TERMINAL_PROFILES,
  resolveTerminalProfiles,
} from "@getpaseo/protocol/terminal-profiles";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";

export function resolveLaunchableTerminalProfiles(
  terminalProfiles: TerminalProfile[] | undefined,
  providerEntries: ProviderSnapshotEntry[] | undefined,
): readonly TerminalProfile[] {
  if (terminalProfiles !== undefined || providerEntries === undefined) {
    return resolveTerminalProfiles(terminalProfiles);
  }
  const uninstalledProviders = new Set(
    providerEntries
      .filter((entry) => entry.status === "unavailable")
      .map((entry) => entry.provider),
  );
  return DEFAULT_TERMINAL_PROFILES.filter((profile) => !uninstalledProviders.has(profile.id));
}

export function useTerminalProfiles(serverId: string | null): readonly TerminalProfile[] {
  const { config } = useDaemonConfig(serverId);
  const { entries } = useProvidersSnapshot(serverId);
  return useMemo(
    () => resolveLaunchableTerminalProfiles(config?.terminalProfiles, entries),
    [config?.terminalProfiles, entries],
  );
}
