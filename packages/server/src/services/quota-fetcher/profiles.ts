import type { ProviderProfileSummary } from "../../server/agent/provider-snapshot-manager.js";
import type { ProviderUsageProfile } from "./provider.js";

/**
 * The configured provider profiles, described the way the usage fetchers need them.
 *
 * The two sides name the same thing differently: a profile's `label` is what the agent
 * list calls it, and a usage card calls that its display name.
 */
export function providerUsageProfilesFrom(
  profiles: readonly ProviderProfileSummary[],
): ProviderUsageProfile[] {
  return profiles.map((profile) => ({
    providerId: profile.providerId,
    baseProviderId: profile.baseProviderId,
    displayName: profile.label,
    env: profile.env,
  }));
}
