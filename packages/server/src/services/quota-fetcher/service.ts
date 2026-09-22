import type { Logger } from "pino";
import type { ProviderUsage } from "../../server/messages.js";
import { createProviderUsageFetchers } from "./manifest.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "./provider.js";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { unavailableUsage, createPluginUsageFetcher } from "./usage.js";

export interface ProviderUsageServiceOptions {
  logger: Logger;
  fetchers?: ProviderUsageFetcher[];
  getPluginProviders?: () => readonly ProviderRegistration[];
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
  private readonly fetchers: ProviderUsageFetcher[];
  private readonly getPluginProviders?: () => readonly ProviderRegistration[];
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private cached: { fetchedAtMs: number; result: ProviderUsageListResult } | null = null;
  private inFlight: Promise<ProviderUsageListResult> | null = null;
  private cacheEpoch = 0;

  constructor(options: ProviderUsageServiceOptions) {
    this.logger = options.logger.child({ module: "provider-usage-service" });
    this.fetchers =
      options.fetchers ??
      createProviderUsageFetchers({
        logger: this.logger,
        fetch: options.fetch,
      });
    this.getPluginProviders = options.getPluginProviders;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  clearCache(): void {
    this.cached = null;
    this.inFlight = null;
    this.cacheEpoch += 1;
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

    const epoch = this.cacheEpoch;
    const request = this.fetchFreshUsage(nowMs, epoch);
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) {
        this.inFlight = null;
      }
    }
  }

  private async fetchFreshUsage(nowMs: number, epoch: number): Promise<ProviderUsageListResult> {
    const seenProviderIds = new Set<string>(this.fetchers.map((fetcher) => fetcher.providerId));
    const pluginFetchers: ProviderUsageFetcher[] = [];
    for (const provider of this.getPluginProviders?.() ?? []) {
      if (typeof provider.fetchUsage !== "function") continue;
      if (seenProviderIds.has(provider.id)) {
        this.logger.warn(
          { providerId: provider.id },
          "Plugin provider usage fetcher skipped due to duplicate providerId",
        );
        continue;
      }
      seenProviderIds.add(provider.id);
      pluginFetchers.push(createPluginUsageFetcher(provider, this.logger));
    }

    const allFetchers = [...this.fetchers, ...pluginFetchers];
    const settled = await Promise.allSettled(allFetchers.map((fetcher) => fetcher.fetchUsage()));
    const providers = settled.map((result, index) => {
      const fetcher = allFetchers[index];
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
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });

    const result = { fetchedAt: new Date(nowMs).toISOString(), providers };
    if (this.cacheEpoch === epoch) {
      this.cached = { fetchedAtMs: nowMs, result };
    }
    return result;
  }
}
