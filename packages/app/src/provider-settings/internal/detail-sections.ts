import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { ProviderInstallationState } from "@/components/provider-installation-section";

export interface DetailSections {
  /** The failure the page leads with, or null. Empty when the provider gave no message. */
  error: string | null;
  /** Models are listed only while the provider runs. */
  models: boolean;
}

/** Which of the detail's state-dependent parts show, so each fact is said once. */
export function readDetailSections(
  entry: ProviderSnapshotEntry,
  installation: ProviderInstallationState,
): DetailSections {
  const notInstalled =
    entry.status === "unavailable" ||
    (installation.status === "ready" &&
      installation.installation?.inspection?.status === "not_installed");
  const failing = entry.enabled && entry.status === "error" && !notInstalled;
  return {
    error: failing ? (entry.error?.trim() ?? "") : null,
    models: entry.enabled && (entry.status === "ready" || entry.status === "loading"),
  };
}

export type DetailPresence =
  | { kind: "found"; entry: ProviderSnapshotEntry }
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "removed" }
  | { kind: "offline" }
  | { kind: "failed"; message: string };

/**
 * Whether the page has a provider to show. A page opened from its URL renders before the host's
 * providers arrive, and its id may name a provider the host no longer has. A provider the page
 * already showed and that then leaves the list was removed, and the page is on its way out.
 */
export function readDetailPresence(input: {
  provider: string;
  connected: boolean;
  entries: ProviderSnapshotEntry[] | undefined;
  error: string | null;
  /** The page has shown this provider before. */
  wasFound: boolean;
}): DetailPresence {
  const entry = input.entries?.find((candidate) => candidate.provider === input.provider);
  if (entry) return { kind: "found", entry };
  if (input.wasFound) return { kind: "removed" };
  if (!input.connected) return { kind: "offline" };
  if (input.entries) return { kind: "missing" };
  if (input.error) return { kind: "failed", message: input.error };
  return { kind: "loading" };
}
