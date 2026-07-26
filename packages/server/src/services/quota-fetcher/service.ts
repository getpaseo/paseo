import type { Logger } from "pino";
import type { ProviderUsage } from "../../server/messages.js";
import { createProviderUsageFetchers, type ClaudeUsageAccountProfile } from "./manifest.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "./provider.js";
import { unavailableUsage } from "./usage.js";

export interface ProviderUsageServiceOptions {
  logger: Logger;
  fetchers?: ProviderUsageFetcher[];
  getClaudeAccounts?: () => readonly ClaudeUsageAccountProfile[];
  fetch?: ProviderApiFetch;
  cacheTtlMs?: number;
  now?: () => number;
}

export interface ProviderUsageListResult {
  fetchedAt: string;
  providers: ProviderUsage[];
}

const DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS = 5 * 60 * 1000;

export class ProviderUsageService {
  private readonly logger: Logger;
  private readonly getFetchers: () => ProviderUsageFetcher[];
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private cached: { fetchedAtMs: number; result: ProviderUsageListResult } | null = null;
  private inFlight: Promise<ProviderUsageListResult> | null = null;
  private generation = 0;

  constructor(options: ProviderUsageServiceOptions) {
    this.logger = options.logger.child({ module: "provider-usage-service" });
    this.getFetchers = options.fetchers
      ? () => options.fetchers ?? []
      : () =>
          createProviderUsageFetchers(
            {
              logger: this.logger,
              fetch: options.fetch,
            },
            options.getClaudeAccounts?.() ?? [],
          );
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async listUsage(options?: { forceRefresh?: boolean }): Promise<ProviderUsageListResult> {
    const nowMs = this.now();
    if (
      !options?.forceRefresh &&
      this.cached &&
      nowMs - this.cached.fetchedAtMs < this.cacheTtlMs
    ) {
      return this.cached.result;
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    const request = this.fetchFreshUsage(nowMs, this.generation);
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) {
        this.inFlight = null;
      }
    }
  }

  invalidate(): void {
    this.generation += 1;
    this.cached = null;
    this.inFlight = null;
  }

  private async fetchFreshUsage(
    nowMs: number,
    generation: number,
  ): Promise<ProviderUsageListResult> {
    const fetchers = this.getFetchers();
    const settled = await Promise.allSettled(fetchers.map((fetcher) => fetcher.fetchUsage()));
    const providers = settled.map((result, index) => {
      const fetcher = fetchers[index];
      if (result.status === "fulfilled") {
        return result.value;
      }
      this.logger.debug(
        { err: result.reason, providerId: fetcher.providerId },
        "Provider usage fetch failed",
      );
      return unavailableUsage({
        providerId: fetcher.providerId,
        displayName: fetcher.displayName,
        iconKey: fetcher.iconKey,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });

    const result = { fetchedAt: new Date(nowMs).toISOString(), providers };
    if (generation === this.generation) {
      this.cached = { fetchedAtMs: nowMs, result };
    }
    return result;
  }
}
