import { createHash } from "node:crypto";
import {
  UsageReportSchema,
  type UsageReportEntry,
  type ProviderUsage,
} from "@getpaseo/protocol/messages";

export interface UsageSource {
  id: string;
  label: string;
  icon?: string;
  discover(): Promise<unknown[]>;
  fetch(input: unknown): Promise<unknown>;
}

/** Owns running sources, account deduplication, and the five-minute fetch cache. */
export class UsageSourceRegistry {
  private readonly sources = new Map<string, UsageSource>();
  private readonly cache = new Map<string, { at: number; entry: UsageReportEntry }>();
  private readonly pending = new Map<string, Promise<UsageReportEntry>>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 300_000,
  ) {}

  register(source: UsageSource): void {
    if (this.sources.has(source.id)) throw new Error(`Duplicate usage source: ${source.id}`);
    this.sources.set(source.id, source);
  }

  unregister(id: string): void {
    this.sources.delete(id);
    for (const key of this.cache.keys()) if (key.startsWith(`${id}:`)) this.cache.delete(key);
  }

  async listReports(options: { forceRefresh?: boolean } = {}): Promise<UsageReportEntry[]> {
    const discovered = await Promise.all(
      [...this.sources.values()].map(async (source) => {
        try {
          const inputs = await source.discover();
          if (!Array.isArray(inputs)) throw new Error("Usage discovery must return an array");
          return await Promise.all(inputs.map((input) => this.fetch(source.id, input, options)));
        } catch (error) {
          return [this.errorEntry(source, error)];
        }
      }),
    );
    const unique = new Map<string, UsageReportEntry>();
    for (const entry of discovered.flat())
      unique.set(`${entry.sourceId}:${entry.report.account.key}`, entry);
    return [...unique.values()];
  }

  // COMPAT(providerUsageList): added in v0.9.3, remove after 2027-03-26.
  async listLegacyUsage(): Promise<{ fetchedAt: string; providers: ProviderUsage[] }> {
    const reports = await this.listReports();
    return {
      fetchedAt: new Date(this.now()).toISOString(),
      providers: reports.map((entry) => ({
        providerId: entry.sourceId,
        displayName: entry.sourceLabel,
        status: entry.report.status,
        planLabel: entry.report.planLabel ?? null,
        windows: entry.report.windows,
        balances: entry.report.balances ?? [],
        details: entry.report.details ?? [],
        error: entry.report.error ?? null,
      })),
    };
  }

  fetch(
    sourceId: string,
    input: unknown,
    options: { forceRefresh?: boolean } = {},
  ): Promise<UsageReportEntry> {
    const source = this.sources.get(sourceId);
    if (!source) throw new Error(`Unknown usage source: ${sourceId}`);
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const key = `${sourceId}:${hash}`;
    const cached = this.cache.get(key);
    if (!options.forceRefresh && cached && this.now() - cached.at < this.ttlMs)
      return Promise.resolve(cached.entry);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const request = (async () => {
      let entry: UsageReportEntry;
      try {
        const report = UsageReportSchema.parse(await source.fetch(input));
        entry = { sourceId, sourceLabel: source.label, icon: source.icon, report };
      } catch (error) {
        entry = this.errorEntry(source, error, hash);
      }
      const now = this.now();
      for (const [cachedKey, stored] of this.cache) {
        if (now - stored.at >= this.ttlMs) this.cache.delete(cachedKey);
      }
      this.cache.set(key, { at: now, entry });
      return entry;
    })();
    this.pending.set(key, request);
    void request.finally(() => {
      if (this.pending.get(key) === request) this.pending.delete(key);
    });
    return request;
  }

  private errorEntry(source: UsageSource, error: unknown, key = source.id): UsageReportEntry {
    return {
      sourceId: source.id,
      sourceLabel: source.label,
      icon: source.icon,
      report: {
        account: { key },
        status: "error",
        windows: [],
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
