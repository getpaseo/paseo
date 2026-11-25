import type { AgentProfile } from "@getpaseo/protocol/messages";

/**
 * The profiles a composer can offer: those naming a provider it can run, one
 * per id. The daemon stores whatever list it is given, so a hand-edited config
 * can repeat an id; the first entry wins, which is also the one `applyProfile`
 * resolves, and every surface that keys on the id stays unique.
 */
export function selectApplicableProfiles(
  profiles: readonly AgentProfile[],
  availableProviders: readonly string[],
): AgentProfile[] {
  const available = new Set(availableProviders);
  const seenIds = new Set<string>();
  const applicable: AgentProfile[] = [];
  for (const profile of profiles) {
    if (!available.has(profile.provider) || seenIds.has(profile.id)) continue;
    seenIds.add(profile.id);
    applicable.push(profile);
  }
  return applicable;
}
