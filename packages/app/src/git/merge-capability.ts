import {
  type ForgeSpecificEnvelope,
  type LegacyGithubMergeFacts,
  type MergeCapability,
} from "@/git/client-forge-module";
import {
  deriveHostMergeCapability,
  type ClientForgeHostSnapshot,
} from "@/git/client-forge-registry";

export type ForgeSpecificStatusFacts = ForgeSpecificEnvelope;

export type { LegacyGithubMergeFacts, MergeCapability };

/**
 * Build the neutral merge capability from a forge's PR status facts. Returns
 * null when the forge supplied no merge facts (e.g. a host that exposes none, or
 * an unknown forge), in which case the caller falls back to raw git state.
 * Per-forge derivation lives on client forge modules; this stays the single
 * neutral entry point the action policy reads.
 *
 * COMPAT(forgeSpecific): forgeSpecific shipped in v0.2.0-beta.1. A daemon
 * predating it emits only the legacy `status.github` field. When forgeSpecific
 * is absent we synthesize the GitHub arm from those legacy facts. Remove after
 * 2027-01-17 once the supported daemon floor is >= v0.2.0.
 */
export function deriveMergeCapability(
  forgeSpecific: unknown,
  host: ClientForgeHostSnapshot,
  legacyGithubFacts?: LegacyGithubMergeFacts | null,
): MergeCapability | null {
  if (forgeSpecific === null || forgeSpecific === undefined) {
    if (legacyGithubFacts) {
      return deriveHostMergeCapability(host, { forge: "github", ...legacyGithubFacts });
    }
    return null;
  }
  return deriveHostMergeCapability(host, forgeSpecific);
}
