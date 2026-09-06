import type { Logger } from "pino";
import type { ProviderUsage } from "../../server/messages.js";

export type ProviderApiFetch = typeof fetch;

export interface ProviderUsageAgentProviderConfig {
  env?: Record<string, string>;
  /**
   * Whether the persisted profile is enabled. Profiles default to enabled; a profile
   * with `enabled === false` is skipped when selecting credentials so quota is never
   * reported for an account the user has turned off.
   */
  enabled?: boolean;
  /**
   * Configured display order for the profile. When several enabled profiles target the
   * same provider, the lowest order wins (undefined sorts last), so selection reflects
   * the user's configured priority rather than incidental map iteration order.
   */
  order?: number;
}

export type ProviderUsageAgentProviderConfigs = Partial<
  Record<string, ProviderUsageAgentProviderConfig>
>;

export interface ProviderUsageFetcher {
  readonly providerId: string;
  readonly displayName: string;
  fetchUsage(): Promise<ProviderUsage>;
}

export interface ProviderUsageFetcherFactoryOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  getAgentProviderConfigs?: () => ProviderUsageAgentProviderConfigs;
}

export interface ProviderUsageFetcherManifestEntry {
  readonly providerId: string;
  create(options: ProviderUsageFetcherFactoryOptions): ProviderUsageFetcher;
}
