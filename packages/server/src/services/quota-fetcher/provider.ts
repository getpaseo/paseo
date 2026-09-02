import type { Logger } from "pino";
import type { ProviderUsage } from "../../server/messages.js";

export type ProviderApiFetch = typeof fetch;

export interface ProviderUsageFetcher {
  readonly providerId: string;
  readonly displayName: string;
  readonly accountProfileId?: string;
  readonly accountName?: string;
  fetchUsage(): Promise<ProviderUsage>;
}

export interface ProviderUsageAccountScope {
  accountProfileId: string;
  accountName: string;
  provider: "codex" | "claude";
  runtimeHome: string;
}

export interface ProviderUsageAccountSource {
  listUsageScopes(): ProviderUsageAccountScope[];
}

export interface ProviderUsageFetcherFactoryOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
}

export interface ProviderUsageFetcherManifestEntry {
  readonly providerId: string;
  create(options: ProviderUsageFetcherFactoryOptions): ProviderUsageFetcher;
}
