import type { Logger } from "pino";
import type { ProviderUsage } from "../../server/messages.js";

export type ProviderApiFetch = typeof fetch;

export interface ProviderUsageFetcher {
  readonly providerId: string;
  readonly displayName: string;
  /**
   * The account this fetcher reports on. Two fetchers sharing a key describe one
   * account, and only the first is kept: the second would draw the same bars again and
   * refresh the same OAuth token, whose rotation would invalidate the first. Providers
   * that cannot identify an account leave this out and are never deduplicated.
   */
  readonly accountKey?: string;
  fetchUsage(): Promise<ProviderUsage>;
}

/**
 * A configured variant of a base provider — `claude-alt` extending `claude` — that runs
 * with its own environment. A profile that points the agent at another account is a
 * separate account to report on, not a relabelling of the base provider's numbers.
 */
export interface ProviderUsageProfile {
  readonly providerId: string;
  readonly baseProviderId: string;
  readonly displayName: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ProviderUsageFetcherFactoryOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  profiles?: readonly ProviderUsageProfile[];
}

export interface ProviderUsageFetcherManifestEntry {
  readonly providerId: string;
  create(options: ProviderUsageFetcherFactoryOptions): ProviderUsageFetcher;
  /**
   * A fetcher for one profile of this provider. A profile that turns out to report on an
   * account another card already covers is dropped by its accountKey, so this only has to
   * describe the profile. Providers that cannot tell profiles apart leave this out.
   */
  createForProfile?(
    options: ProviderUsageFetcherFactoryOptions,
    profile: ProviderUsageProfile,
  ): ProviderUsageFetcher;
}
