import type { Logger } from "pino";
import type { ProviderUsage } from "../../server/messages.js";
import { createProviderAccountUsageFetcher, createProviderUsageFetchers } from "./manifest.js";
import type {
  ProviderApiFetch,
  ProviderUsageAccountScope,
  ProviderUsageAccountSource,
  ProviderUsageFetcher,
  ProviderUsageFetcherFactoryOptions,
} from "./provider.js";
import { unavailableUsage } from "./usage.js";

export interface ProviderUsageServiceOptions {
  logger: Logger;
  fetchers?: ProviderUsageFetcher[];
  fetch?: ProviderApiFetch;
  cacheTtlMs?: number;
  now?: () => number;
  accountSource?: ProviderUsageAccountSource | null;
}

export interface ProviderUsageListResult {
  fetchedAt: string;
  providers: ProviderUsage[];
}

const DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS = 5 * 60 * 1000;

export class ProviderUsageService {
  private readonly logger: Logger;
  private readonly fetchers: ProviderUsageFetcher[];
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly accountSource: ProviderUsageAccountSource | null;
  private readonly fetcherFactoryOptions: ProviderUsageFetcherFactoryOptions;
  private cached: {
    fetchedAtMs: number;
    accountScopeKey: string;
    result: ProviderUsageListResult;
  } | null = null;
  private inFlight: Promise<ProviderUsageListResult> | null = null;

  constructor(options: ProviderUsageServiceOptions) {
    this.logger = options.logger.child({ module: "provider-usage-service" });
    this.fetchers =
      options.fetchers ??
      createProviderUsageFetchers({
        logger: this.logger,
        fetch: options.fetch,
      });
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.accountSource = options.accountSource ?? null;
    this.fetcherFactoryOptions = { logger: this.logger, fetch: options.fetch };
  }

  async listUsage(options?: { forceRefresh?: boolean }): Promise<ProviderUsageListResult> {
    const nowMs = this.now();
    const accountScopes = this.accountSource?.listUsageScopes() ?? [];
    const accountScopeKey = buildAccountScopeKey(accountScopes);
    if (
      !options?.forceRefresh &&
      this.cached &&
      this.cached.accountScopeKey === accountScopeKey &&
      nowMs - this.cached.fetchedAtMs < this.cacheTtlMs
    ) {
      return this.cached.result;
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    const request = this.fetchFreshUsage(nowMs, accountScopes, accountScopeKey);
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) {
        this.inFlight = null;
      }
    }
  }

  private async fetchFreshUsage(
    nowMs: number,
    accountScopes: ProviderUsageAccountScope[],
    accountScopeKey: string,
  ): Promise<ProviderUsageListResult> {
    const fetchers = this.buildFetchers(accountScopes);
    const settled = await Promise.allSettled(fetchers.map((fetcher) => fetcher.fetchUsage()));
    const providers = settled.map((result, index) => {
      const fetcher = fetchers[index];
      if (result.status === "fulfilled") {
        return annotateAccountUsage(result.value, fetcher, accountScopes);
      }
      this.logger.debug(
        { err: result.reason, providerId: fetcher.providerId },
        "Provider usage fetch failed",
      );
      return annotateAccountUsage(
        unavailableUsage({
          providerId: fetcher.providerId,
          displayName: fetcher.displayName,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }),
        fetcher,
        accountScopes,
      );
    });

    const result = { fetchedAt: new Date(nowMs).toISOString(), providers };
    this.cached = { fetchedAtMs: nowMs, accountScopeKey, result };
    return result;
  }

  private buildFetchers(accountScopes: ProviderUsageAccountScope[]): ProviderUsageFetcher[] {
    return this.fetchers.flatMap((fetcher) => [
      fetcher,
      ...accountScopes
        .filter((scope) => scope.provider === fetcher.providerId)
        .map((scope) => createProviderAccountUsageFetcher(scope, this.fetcherFactoryOptions)),
    ]);
  }
}

function buildAccountScopeKey(scopes: ProviderUsageAccountScope[]): string {
  return scopes
    .map((scope) => `${scope.provider}:${scope.accountProfileId}:${scope.accountName}`)
    .sort()
    .join("|");
}

function annotateAccountUsage(
  usage: ProviderUsage,
  fetcher: ProviderUsageFetcher,
  scopes: ProviderUsageAccountScope[],
): ProviderUsage {
  if (fetcher.accountProfileId) {
    return {
      ...usage,
      accountProfileId: fetcher.accountProfileId,
      accountName: fetcher.accountName,
    };
  }
  const hasManagedAccounts = scopes.some((scope) => scope.provider === fetcher.providerId);
  return hasManagedAccounts
    ? { ...usage, accountProfileId: null, accountName: "System account" }
    : usage;
}
