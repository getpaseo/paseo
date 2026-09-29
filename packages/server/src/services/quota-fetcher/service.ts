import type { Logger } from "pino";
import type { ProviderUsage } from "../../server/messages.js";
import { createProviderUsageFetchers } from "./manifest.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "./provider.js";
import { unavailableUsage } from "./usage.js";
import { ClaudeQuotaProvider } from "./providers/claude.js";
import { CodexQuotaProvider } from "./providers/codex.js";

/** A provider as configured: a built-in one or a profile that extends it with its own home. */
export interface UsageProviderProfile {
  id: string;
  /** The built-in provider a profile extends; null for a built-in provider itself. */
  extends: string | null;
  label: string | null;
  enabled: boolean;
  env: Record<string, string>;
}

export interface ProviderUsageServiceOptions {
  logger: Logger;
  fetchers?: ProviderUsageFetcher[];
  fetch?: ProviderApiFetch;
  cacheTtlMs?: number;
  now?: () => number;
  /** Read on every fresh fetch, so enabling a profile or adding one shows up without restart. */
  listProfiles?: () => UsageProviderProfile[];
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
  private readonly listProfiles: (() => UsageProviderProfile[]) | null;
  private readonly fetchApi: ProviderApiFetch | undefined;
  private cached: {
    fetchedAtMs: number;
    profilesKey: string;
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
    this.listProfiles = options.listProfiles ?? null;
    this.fetchApi = options.fetch;
  }

  // One card per account: disabled providers drop out, and every enabled Codex or Claude
  // profile gets its own fetcher reading that profile's login.
  private resolveFetchers(): ProviderUsageFetcher[] {
    if (!this.listProfiles) return this.fetchers;
    const profiles = this.listProfiles();
    const disabled = new Set(
      profiles.filter((profile) => !profile.enabled).map((profile) => profile.id),
    );
    const fetchers = this.fetchers.filter((fetcher) => !disabled.has(fetcher.providerId));
    for (const profile of profiles) {
      if (!profile.enabled || !profile.extends) continue;
      const displayName = profile.label ?? profile.id;
      if (profile.extends === "codex") {
        fetchers.push(
          new CodexQuotaProvider({
            logger: this.logger,
            fetch: this.fetchApi,
            codexHome: profile.env["CODEX_HOME"],
            providerId: profile.id,
            displayName,
          }),
        );
      } else if (profile.extends === "claude") {
        fetchers.push(
          new ClaudeQuotaProvider({
            logger: this.logger,
            fetch: this.fetchApi,
            claudeHome: profile.env["CLAUDE_CONFIG_DIR"] ?? profile.env["CLAUDE_HOME"],
            providerId: profile.id,
            displayName,
          }),
        );
      }
    }
    return fetchers;
  }

  async listUsage(options?: { forceRefresh?: boolean }): Promise<ProviderUsageListResult> {
    const nowMs = this.now();
    // An added, removed or toggled account must show at once, not after the cache expires.
    const profilesKey = JSON.stringify(this.listProfiles?.() ?? null);
    if (
      !options?.forceRefresh &&
      this.cached &&
      this.cached.profilesKey === profilesKey &&
      nowMs - this.cached.fetchedAtMs < this.cacheTtlMs
    ) {
      return this.cached.result;
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    const request = this.fetchFreshUsage(nowMs, profilesKey);
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
    profilesKey: string,
  ): Promise<ProviderUsageListResult> {
    const fetchers = this.resolveFetchers();
    const baseById = new Map(
      (this.listProfiles?.() ?? []).flatMap((profile) =>
        profile.extends ? [[profile.id, profile.extends] as const] : [],
      ),
    );
    const settled = await Promise.allSettled(fetchers.map((fetcher) => fetcher.fetchUsage()));
    const providers = settled.map((result, index) => {
      const usage = this.settledUsage(fetchers[index]!, result);
      const baseProviderId = baseById.get(usage.providerId);
      if (baseProviderId) usage.baseProviderId = baseProviderId;
      return usage;
    });

    const result = { fetchedAt: new Date(nowMs).toISOString(), providers };
    this.cached = { fetchedAtMs: nowMs, profilesKey, result };
    return result;
  }

  private settledUsage(
    fetcher: ProviderUsageFetcher,
    result: PromiseSettledResult<ProviderUsage>,
  ): ProviderUsage {
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
  }
}
