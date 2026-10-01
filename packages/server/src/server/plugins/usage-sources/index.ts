import {
  UsageReportSchema,
  type ProviderUsage,
  type UsageReportEntry,
} from "@getpaseo/protocol/messages";

export interface UsageSource {
  id: string;
  label: string;
  icon?: string;
  discover(): Promise<unknown[]>;
  identify(input: unknown): Promise<{ key: string; label?: string } | null>;
  fetch(input: unknown): Promise<unknown>;
}

interface KnownReport {
  source: UsageSource;
  inputs: unknown[];
  label?: string;
}

/** Owns account identity, ordered logins for each account, and the five-minute fetch cache. */
export class UsageSourceRegistry {
  private readonly sources = new Map<string, UsageSource>();
  private readonly known = new Map<string, KnownReport>();
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
    for (const key of this.known.keys()) if (key.startsWith(`${id}:`)) this.known.delete(key);
    for (const key of this.cache.keys()) if (key.startsWith(`${id}:`)) this.cache.delete(key);
  }

  private async identify(
    source: UsageSource,
    input: unknown,
  ): Promise<{ id: string; label?: string; error?: true } | null> {
    try {
      const account = await source.identify(input);
      if (account === null) return null;
      if (
        typeof account !== "object" ||
        (account.label !== undefined && typeof account.label !== "string")
      )
        throw new Error(`Invalid account identity from ${source.id}`);
      if (typeof account.key !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(account.key))
        throw new Error(`Invalid account key from ${source.id}`);
      return { id: `${source.id}:${account.key}`, label: account.label };
    } catch (error) {
      const id = `${source.id}:!error`;
      this.writeCache(id, this.errorEntry(source, id, error));
      return { id, error: true };
    }
  }

  async listReports(
    options: { forceRefresh?: boolean; reportIds?: string[] } = {},
  ): Promise<UsageReportEntry[]> {
    const ids = options.reportIds ?? (await this.discoverReportIds());
    return Promise.all(
      [...new Set(ids)]
        .filter((id) => this.known.has(id) || this.cache.has(id))
        .map((id) => this.fetchId(id, options.forceRefresh)),
    );
  }

  private async discoverReportIds(): Promise<string[]> {
    const discovered = await Promise.all(
      [...this.sources.values()].map(async (source) => {
        try {
          const inputs = await source.discover();
          if (!Array.isArray(inputs)) throw new Error("Usage discovery must return an array");
          const accounts = await Promise.all(inputs.map((input) => this.identify(source, input)));
          // Group in discovery order so an account's logins keep the source's preference.
          const knownReports = new Map<string, KnownReport>();
          const ids: string[] = [];
          accounts.forEach((account, index) => {
            if (account === null) return;
            ids.push(account.id);
            if (account.error) return;
            const known = knownReports.get(account.id);
            if (known) known.inputs.push(inputs[index]);
            else
              knownReports.set(account.id, {
                source,
                inputs: [inputs[index]],
                label: account.label,
              });
          });
          for (const key of this.known.keys()) {
            if (key.startsWith(`${source.id}:`)) this.known.delete(key);
          }
          for (const [id, known] of knownReports) this.known.set(id, known);
          return ids;
        } catch (error) {
          const id = `${source.id}:!error`;
          this.writeCache(id, this.errorEntry(source, id, error));
          return [id];
        }
      }),
    );
    return discovered.flat();
  }

  // COMPAT(providerUsageList): added in v0.1.98, remove after 2027-03-26.
  async listLegacyUsage(): Promise<{ fetchedAt: string; providers: ProviderUsage[] }> {
    const reports = await this.listReports();
    return {
      fetchedAt: reports.length
        ? reports.reduce(
            (oldest, entry) => (entry.fetchedAt < oldest ? entry.fetchedAt : oldest),
            reports[0]!.fetchedAt,
          )
        : new Date(this.now()).toISOString(),
      providers: reports.map((entry) => ({
        providerId: entry.sourceId,
        displayName: entry.account.label
          ? `${entry.sourceLabel} (${entry.account.label})`
          : entry.sourceLabel,
        status: entry.report.status,
        planLabel: entry.report.planLabel ?? null,
        windows: entry.report.windows,
        balances: entry.report.balances ?? [],
        details: entry.report.details ?? [],
        error: entry.report.error ?? null,
      })),
    };
  }

  private fetchId(id: string, forceRefresh = false): Promise<UsageReportEntry> {
    const known = this.known.get(id);
    const cached = this.cache.get(id);
    if (!known) return Promise.resolve(cached!.entry);
    if (!forceRefresh && cached && this.now() - cached.at < this.ttlMs)
      return Promise.resolve(cached.entry);
    const pending = this.pending.get(id);
    if (pending) return pending;
    const request = (async () => {
      let entry: UsageReportEntry = {
        id,
        sourceId: known.source.id,
        sourceLabel: known.source.label,
        icon: known.source.icon,
        account: { label: known.label },
        fetchedAt: new Date(this.now()).toISOString(),
        report: { status: "unavailable", windows: [] },
      };
      for (const input of known.inputs) {
        try {
          // A harness can switch accounts between discovery and a targeted refresh.
          const account = await known.source.identify(input);
          if (!account || `${known.source.id}:${account.key}` !== id) continue;
          const report = UsageReportSchema.parse(await known.source.fetch(input));
          entry.report = report;
          if (report.status === "available") break;
        } catch (error) {
          entry = this.errorEntry(known.source, id, error, known.label);
        }
      }
      this.writeCache(id, entry);
      return entry;
    })();
    this.pending.set(id, request);
    void request.finally(() => {
      if (this.pending.get(id) === request) this.pending.delete(id);
    });
    return request;
  }

  private writeCache(id: string, entry: UsageReportEntry): void {
    const at = this.now();
    for (const [cachedId, cached] of this.cache) {
      if (at - cached.at >= this.ttlMs) this.cache.delete(cachedId);
    }
    this.cache.set(id, { at, entry });
  }

  private errorEntry(
    source: UsageSource,
    id: string,
    error: unknown,
    label?: string,
    fetchedAt = new Date(this.now()).toISOString(),
  ): UsageReportEntry {
    return {
      id,
      sourceId: source.id,
      sourceLabel: source.label,
      icon: source.icon,
      account: { label },
      fetchedAt,
      report: {
        status: "error",
        windows: [],
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
