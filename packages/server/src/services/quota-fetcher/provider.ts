import type { Logger } from "pino";
import type { ProviderUsage } from "../../server/messages.js";

export type ProviderApiFetch = typeof fetch;

export interface ClaudeUsageLaunchConfig {
  command?: readonly string[];
  teamClaudeConfigPath?: string;
  xdgConfigHome?: string;
}

export interface ProviderUsageFetcher {
  readonly providerId: string;
  readonly displayName: string;
  fetchUsage(): Promise<ProviderUsage>;
}

export interface ProviderUsageFetcherFactoryOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  claudeLaunch?: ClaudeUsageLaunchConfig;
}

export interface ProviderUsageFetcherManifestEntry {
  readonly providerId: string;
  create(options: ProviderUsageFetcherFactoryOptions): ProviderUsageFetcher;
}
