import {
  type ForgeSpecificEnvelope,
  type LegacyGithubMergeFacts,
  type MergeCapability,
} from "@/git/client-forge-module";
import { CLIENT_FORGE_LOGIC_MODULES } from "@/git/forges";

export type ForgeSpecificStatusFacts = ForgeSpecificEnvelope;

export type { LegacyGithubMergeFacts, MergeCapability };

/**
 * Resolve the neutral merge capability from a registered forge's runtime facts.
 * Returns null for an unregistered, unknown, or schema-mismatched facts family;
 * callers then fall back to raw git state.
 */
function deriveForgeMergeCapability(facts: unknown): MergeCapability | null {
  for (const module of CLIENT_FORGE_LOGIC_MODULES) {
    const capability = module.facts?.deriveMergeCapability(facts);
    if (capability) {
      return capability;
    }
  }
  return null;
}

/**
 * Build the neutral merge capability from a forge's PR status facts. Returns
 * null when the forge supplied no merge facts (e.g. a host that exposes none, or
 * an unknown forge), in which case the caller falls back to raw git state.
 * Per-forge derivation lives on client forge modules; this stays the single
 * neutral entry point the action policy reads.
 *
 * COMPAT(forgeSpecific): added in v0.1.106, remove after 2026-12-27. A daemon
 * predating forgeSpecific emits only the legacy `status.github` field. When
 * forgeSpecific is absent we synthesize the github arm from those legacy facts
 * so GitHub merge-method restrictions and auto-merge state are not lost against
 * an old daemon.
 */
export function deriveMergeCapability(
  forgeSpecific: unknown,
  legacyGithubFacts?: LegacyGithubMergeFacts | null,
): MergeCapability | null {
  if (forgeSpecific === null || forgeSpecific === undefined) {
    if (legacyGithubFacts) {
      return deriveForgeMergeCapability({ forge: "github", ...legacyGithubFacts });
    }
    return null;
  }
  return deriveForgeMergeCapability(forgeSpecific);
}
