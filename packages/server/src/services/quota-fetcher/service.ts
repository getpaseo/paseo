import type { Logger } from "pino";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import type { ProviderUsage } from "../../server/messages.js";
import { createProviderUsageFetchers } from "./manifest.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "./provider.js";
import { unavailableUsage } from "./usage.js";

export interface ProviderUsageServiceOptions {
  logger: Logger;
  fetchers?: ProviderUsageFetcher[];
  fetch?: ProviderApiFetch;
  providerConfigs?: MutableDaemonConfig["providers"];
  fetcherFactory?: (providers: MutableDaemonConfig["providers"]) => ProviderUsageFetcher[];
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
  private fetchers: ProviderUsageFetcher[];
  private readonly rebuildFetchers:
    | ((providers: MutableDaemonConfig["providers"]) => ProviderUsageFetcher[])
    | null;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private cached: { fetchedAtMs: number; result: ProviderUsageListResult } | null = null;
  private inFlight: Promise<ProviderUsageListResult> | null = null;
  private revision = 0;

  constructor(options: ProviderUsageServiceOptions) {
    this.logger = options.logger.child({ module: "provider-usage-service" });
    const factoryOptions = {
      logger: this.logger,
      fetch: options.fetch,
    };
    this.rebuildFetchers = options.fetchers
      ? null
      : (options.fetcherFactory ??
        ((providers) => createProviderUsageFetchers(factoryOptions, providers)));
    this.fetchers = options.fetchers ?? this.rebuildFetchers?.(options.providerConfigs ?? {}) ?? [];
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  updateProviderConfigs(providers: MutableDaemonConfig["providers"]): void {
    if (!this.rebuildFetchers) return;
    this.fetchers = this.rebuildFetchers(providers);
    this.revision += 1;
    this.cached = null;
    this.inFlight = null;
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

    const request = this.fetchFreshUsage(nowMs, this.revision);
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) {
        this.inFlight = null;
      }
    }
  }

  private async fetchFreshUsage(nowMs: number, revision: number): Promise<ProviderUsageListResult> {
    const fetchers = this.fetchers;
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
        baseProviderId: fetcher.baseProviderId,
        displayName: fetcher.displayName,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });

    const result = { fetchedAt: new Date(nowMs).toISOString(), providers };
    if (revision === this.revision) {
      this.cached = { fetchedAtMs: nowMs, result };
    }
    return result;
  }
}
