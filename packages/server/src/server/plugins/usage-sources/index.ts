import { createHash } from "node:crypto";
import type { AgentUsageSession, ProviderUsageEnvironment } from "../../agent/agent-sdk-types.js";
import {
  toneFromUsedPct,
  type UsageBalance,
  type UsageScope,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import type { Logger } from "pino";
import {
  UsageReportSchema,
  type ProviderUsage,
  type UsageReportEntry,
  type UsageProblem,
  type UsageReport,
} from "@getpaseo/protocol/messages";
import { selectProviderUsageEnv } from "./provider-env.js";

export interface UsageSource {
  id: string;
  label: string;
  icon?: string;
  /** Provider IDs associated with this source, used for default visibility and scoped host discovery. */
  providers?: readonly string[];
  discover(scope: UsageScope): Promise<unknown>;
  fetch(input: unknown): Promise<unknown>;
}

interface Login {
  input: unknown;
  harness: string;
  provider?: string;
}

interface KnownReport {
  source: UsageSource;
  logins: [Login, ...Login[]];
  label?: string;
}

export interface AgentUsageLookup {
  hasAgent(id: string): boolean;
  usageSession(id: string): AgentUsageSession | null;
  /** Enabled providers configured with usage-locator env vars for scoped host discovery. */
  providerEnvironments?(): ProviderUsageEnvironment[];
  resolveLaunch?(
    provider: string,
  ): Promise<import("@getpaseo/plugin/server/provider").ProviderLaunch | undefined>;
  /** Whether the provider (or a custom provider derived from it) is installed and enabled. */
  isProviderActive?(provider: string, options?: { forceRefresh?: boolean }): Promise<boolean>;
}

interface DiscoverOptions {
  scope: UsageScope;
  /** When set, dispatch ONLY to usage sources whose declared `providers` includes this ID. */
  matchProvider?: string;
  /** Names logins discovered in this scope; defaults to the account's harness or source label. */
  harness?: string;
  /** This scope's last result; a source whose discovery fails keeps its accounts from it. */
  previous?: ReadonlyMap<string, KnownReport>;
}

interface PresentReportOptions {
  entry: UsageReportEntry;
  known: KnownReport;
}

interface MergeReportsOptions {
  into: Map<string, KnownReport>;
  reports: Iterable<[string, KnownReport]>;
}

/** Usage an agent's provider saw while working, in a usage source's canonical shapes. */
export interface UsageObservation {
  sourceId: string;
  /** Empty when usage moved by an unknown amount: the account's report is refetched instead. */
  windows: UsageWindow[];
  balances?: UsageBalance[];
  planLabel?: string;
}

// A failed fetch is retried sooner than a successful one is refreshed, doubling up to the TTL.
// A source that was told to wait (Claude's 429 Retry-After) answers from its own wait until then,
// so these retries never reach the vendor early.
const ERROR_RETRY_MS = 30_000;
// Refetches an observation asks for, at most this often per report.
const OBSERVED_REFETCH_INTERVAL_MS = 60_000;

export interface ListUsageReportsOptions {
  forceRefresh?: boolean;
  reportIds?: string[];
  agentId?: string;
  onReport?: (report: UsageReportEntry) => void;
}

/**
 * Groups discovered logins by account and caches their usage for five minutes (failures for
 * less). Usage an agent observes while working is merged into the cached report of its account
 * and announced to subscribers.
 */
export class UsageSourceRegistry {
  private readonly sources = new Map<string, UsageSource>();
  private readonly known = new Map<string, KnownReport>();
  private defaults = new Map<string, KnownReport>();
  private defaultsByScope = new Map<string, Map<string, KnownReport>>();
  private readonly byAgent = new Map<string, Map<string, KnownReport>>();
  private readonly cache = new Map<string, { at: number; entry: UsageReportEntry }>();
  private readonly successful = new Map<string, NonNullable<UsageReportEntry["lastSuccessful"]>>();
  private readonly pending = new Map<string, Promise<UsageReportEntry>>();
  private readonly failures = new Map<string, number>();
  private readonly listeners = new Set<(entry: UsageReportEntry) => void>();
  // Agents whose account was resolved only to place an observation. Kept apart from `byAgent`,
  // which also decides the host list, so working does not add an agent's account to it.
  private readonly observedAgents = new Map<
    string,
    { sessionKey: string; reports: Promise<Map<string, KnownReport>> }
  >();
  private readonly observedRefetchAt = new Map<string, number>();
  private readonly observedRefetchTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; known: KnownReport }
  >();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 300_000,
    private readonly logger: Pick<Logger, "warn"> = { warn: console.warn },
    private readonly agents: AgentUsageLookup = { hasAgent: () => false, usageSession: () => null },
    private readonly deadlineMs = 20_000,
  ) {}

  register(source: UsageSource): void {
    if (this.sources.has(source.id)) throw new Error(`Duplicate usage source: ${source.id}`);
    this.sources.set(source.id, source);
  }

  unregister(id: string): void {
    const prefix = `${id}:`;
    this.sources.delete(id);
    deletePrefixed(this.defaults, prefix);
    for (const reports of this.defaultsByScope.values()) deletePrefixed(reports, prefix);
    for (const reports of this.byAgent.values()) deletePrefixed(reports, prefix);
    deletePrefixed(this.known, prefix);
    deletePrefixed(this.cache, prefix);
    deletePrefixed(this.successful, prefix);
    deletePrefixed(this.pending, prefix);
    deletePrefixed(this.failures, prefix);
    deletePrefixed(this.observedRefetchAt, prefix);
    for (const [key, entry] of this.observedRefetchTimers) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(entry.timer);
      this.observedRefetchTimers.delete(key);
    }
    this.observedAgents.clear();
  }

  /** Called with each report the registry updates on its own, outside any list request. */
  subscribe(listener: (entry: UsageReportEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Merges usage an agent observed into the cached reports of the account it runs under, and
   * announces each one changed. Windows the observation does not name (per-model weekly limits)
   * keep their fetched values, and the cache keeps its fetch time, so the next refresh still
   * fetches them. With no values, or no successful report to merge into, the report is refetched
   * instead, at most once a minute. With no app listening, only reports a client already listed
   * take the observation: nothing is discovered or fetched, so a busy host doesn't spend the
   * vendor's rate limit in the background.
   */
  async observeUsage(agentId: string, observation: UsageObservation): Promise<void> {
    const listening = this.listeners.size > 0;
    const reports = listening
      ? await this.observedReports(agentId)
      : (this.byAgent.get(agentId) ?? new Map<string, KnownReport>());
    const hasData =
      observation.windows.length > 0 ||
      (observation.balances?.length ?? 0) > 0 ||
      observation.planLabel !== undefined;
    for (const [id, report] of reports) {
      if (
        report.source.id !== observation.sourceId ||
        this.sources.get(report.source.id) !== report.source
      )
        continue;
      if (hasData && this.mergeObservation(id, observation)) continue;
      if (listening) this.refetchObserved(id, this.known.get(id) ?? report);
    }
  }

  private async observedReports(agentId: string): Promise<Map<string, KnownReport>> {
    const listed = this.byAgent.get(agentId);
    if (listed) return listed;
    const session = this.agents.usageSession(agentId);
    if (!session) {
      this.observedAgents.delete(agentId);
      return new Map();
    }
    const observed = this.observedAgents.get(agentId);
    if (observed?.sessionKey === session.sessionKey) return observed.reports;
    const reports = this.discover({
      scope: {
        kind: "session",
        provider: session.provider,
        model: session.model,
        env: session.env,
        launch: session.launch,
      },
    });
    this.observedAgents.set(agentId, { sessionKey: session.sessionKey, reports });
    return reports;
  }

  /** Whether any cached report of the account took the observed values. */
  private mergeObservation(id: string, observation: UsageObservation): boolean {
    let merged = false;
    for (const [cacheKey, cached] of this.cache) {
      const { entry } = cached;
      if (entry.id !== id || entry.report.status !== "available") continue;
      const report = mergeObservedReport(entry.report, observation);
      if (!report) continue;
      const at = new Date(this.now()).toISOString();
      const next: UsageReportEntry = { ...entry, fetchedAt: at, successfulAt: at, report };
      this.cache.set(cacheKey, { at: cached.at, entry: next });
      this.successful.set(cacheKey, { fetchedAt: at, report });
      this.announce(next);
      merged = true;
    }
    return merged;
  }

  private refetchObserved(id: string, known: KnownReport): void {
    const last = this.observedRefetchAt.get(id);
    const now = this.now();
    const remaining = last === undefined ? 0 : OBSERVED_REFETCH_INTERVAL_MS - (now - last);
    if (remaining > 0) {
      const existing = this.observedRefetchTimers.get(id);
      if (existing) {
        existing.known = known;
        return;
      }
      const pending = {
        known,
        timer: setTimeout(() => {
          this.observedRefetchTimers.delete(id);
          if (
            this.listeners.size === 0 ||
            this.sources.get(pending.known.source.id) !== pending.known.source
          ) {
            return;
          }
          this.refetchObserved(id, this.known.get(id) ?? pending.known);
        }, remaining),
      };
      pending.timer.unref?.();
      this.observedRefetchTimers.set(id, pending);
      return;
    }
    const existing = this.observedRefetchTimers.get(id);
    if (existing) {
      clearTimeout(existing.timer);
      this.observedRefetchTimers.delete(id);
    }
    this.observedRefetchAt.set(id, now);
    void this.fetchId(id, known, true)
      .then((entry) => this.announce(presentReport({ entry, known })))
      .catch((error) => this.logger.warn({ err: error }, "Observed usage refetch failed"));
  }

  private announce(entry: UsageReportEntry): void {
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch (error) {
        this.logger.warn({ err: error }, "Usage report listener failed");
      }
    }
  }

  async listReports(options: ListUsageReportsOptions = {}): Promise<UsageReportEntry[]> {
    if (options.agentId !== undefined && options.reportIds !== undefined)
      throw new Error("agentId and reportIds cannot be combined");
    this.pruneAgents();
    let ids: string[];
    let reports = this.known;
    if (options.agentId !== undefined) {
      if (!this.agents.hasAgent(options.agentId))
        throw new Error(`Unknown agent: ${options.agentId}`);
      reports = await this.discoverAgent(options.agentId);
      this.mergeKnown();
      ids = [...reports.keys()];
    } else if (options.reportIds !== undefined) {
      ids = options.reportIds;
    } else {
      const [defaults] = await Promise.all([
        this.discoverHost(),
        ...[...this.byAgent.keys()].map((agentId) => this.discoverAgent(agentId)),
      ]);
      this.defaults = defaults;
      this.mergeKnown();
      ids = [...this.known.keys()];
    }
    const uniqueIds = [...new Set(ids)];
    const checkProvider =
      options.agentId === undefined
        ? this.createProviderActivityChecker(options.forceRefresh)
        : undefined;
    return Promise.all(
      uniqueIds.flatMap((id) => {
        const known = reports.get(id);
        if (!known) return [];
        // Resolve each report's provider hint alongside its fetch so a slow provider probe
        // never blocks unrelated reports from fetching or streaming.
        return [
          Promise.all([
            this.fetchId(id, known, options.forceRefresh),
            this.resolveDefaultEnabled(known, checkProvider),
          ]).then(([entry, defaultEnabled]) => {
            const presented = presentReport({ entry, known });
            const stamped =
              defaultEnabled === false ? { ...presented, defaultEnabled: false } : presented;
            options.onReport?.(stamped);
            return stamped;
          }),
        ];
      }),
    );
  }

  private configuredProviderScopes(): DiscoverOptions[] {
    const scopes: DiscoverOptions[] = [];
    for (const {
      provider,
      label,
      env,
      configuredEnvKeys,
    } of this.agents.providerEnvironments?.() ?? []) {
      const sanitizedEnv = selectProviderUsageEnv({ provider, env, configuredEnvKeys });
      if (!sanitizedEnv) continue;
      scopes.push({
        scope: { kind: "session", provider, env: sanitizedEnv },
        matchProvider: provider,
        harness: label,
      });
    }
    return scopes;
  }

  private async discoverHost(): Promise<Map<string, KnownReport>> {
    // A configured provider's own locator env can name a login the daemon's default env doesn't,
    // so discover it before any of its agents run. The host's global logins come first in each
    // account's fallback order. Configured-provider scopes are dispatched ONLY to sources whose
    // declared `providers` includes that provider's base ID and carry ONLY allowlisted locator vars.
    const scopes: DiscoverOptions[] = [
      { scope: { kind: "global" } },
      ...this.configuredProviderScopes(),
    ];
    // Each launch environment is discovered once, under the first provider that uses it,
    // and keeps its own last result across transient discovery failures.
    const unique = new Map<string, DiscoverOptions>();
    for (const entry of scopes) {
      const key = canonicalJson(entry.scope);
      if (!unique.has(key)) unique.set(key, entry);
    }
    const previous = this.defaultsByScope;
    const settled = await Promise.all(
      [...unique].map(
        async ([key, entry]) =>
          [key, await this.discover({ ...entry, previous: previous.get(key) })] as const,
      ),
    );
    this.defaultsByScope = new Map(settled);
    const defaults = new Map<string, KnownReport>();
    for (const scoped of this.defaultsByScope.values()) {
      mergeReports({ into: defaults, reports: scoped });
    }
    return defaults;
  }

  private hintedProviders(known: KnownReport): string[] {
    const fromLogins = [
      ...new Set(known.logins.flatMap((login) => (login.provider ? [login.provider] : []))),
    ];
    if (fromLogins.length > 0) return fromLogins;
    return known.source.providers ? [...new Set(known.source.providers)] : [];
  }

  private createProviderActivityChecker(
    forceRefresh?: boolean,
  ): ((provider: string) => Promise<boolean>) | undefined {
    const isProviderActive = this.agents.isProviderActive;
    if (!isProviderActive) return undefined;
    const checks = new Map<string, Promise<boolean>>();
    return (provider: string) => {
      const existing = checks.get(provider);
      if (existing) return existing;
      const check = isProviderActive(provider, { forceRefresh }).catch((error) => {
        this.logger.warn({ provider, err: error }, "Usage provider availability hint failed");
        return true;
      });
      checks.set(provider, check);
      return check;
    };
  }

  private async resolveDefaultEnabled(
    known: KnownReport,
    checkProvider: ((provider: string) => Promise<boolean>) | undefined,
  ): Promise<boolean | undefined> {
    if (!checkProvider) return undefined;
    const hinted = this.hintedProviders(known);
    if (hinted.length === 0) return undefined;
    return (await anyTrue(hinted.map(checkProvider))) ? undefined : false;
  }

  private pruneAgents(): void {
    for (const id of this.byAgent.keys()) {
      if (!this.agents.hasAgent(id)) this.byAgent.delete(id);
    }
    for (const id of this.observedAgents.keys()) {
      if (!this.agents.hasAgent(id)) this.observedAgents.delete(id);
    }
    this.mergeKnown();
  }

  private async discoverAgent(agentId: string): Promise<Map<string, KnownReport>> {
    const session = this.agents.usageSession(agentId);
    if (!session) {
      this.byAgent.delete(agentId);
      return new Map();
    }
    const previous = this.byAgent.get(agentId);
    const reports = await this.discover({
      scope: {
        kind: "session",
        provider: session.provider,
        model: session.model,
        env: session.env,
        launch: session.launch,
      },
    });
    const current = this.agents.usageSession(agentId);
    if (
      current?.sessionKey !== session.sessionKey ||
      current.provider !== session.provider ||
      current.model !== session.model
    ) {
      if (this.byAgent.get(agentId) === previous) this.byAgent.delete(agentId);
      return new Map();
    }

    this.byAgent.set(agentId, reports);
    return reports;
  }

  private mergeKnown(): void {
    this.known.clear();
    for (const reports of [this.defaults, ...this.byAgent.values()]) {
      mergeReports({
        into: this.known,
        reports: [...reports].filter(
          ([, report]) => this.sources.get(report.source.id) === report.source,
        ),
      });
    }
    // Fetch freshness expires independently of successful snapshots. Retain only live identities.
    const active = this.activeCacheKeys();
    for (const key of this.successful.keys()) if (!active.has(key)) this.successful.delete(key);
    for (const key of this.cache.keys()) if (!active.has(key)) this.cache.delete(key);
    for (const key of this.failures.keys()) if (!active.has(key)) this.failures.delete(key);
  }

  private activeCacheKeys(): Set<string> {
    return new Set(
      [this.known, this.defaults, ...this.byAgent.values()].flatMap((reports) =>
        [...reports].map(([id, report]) => cacheIdentity(id, report)),
      ),
    );
  }

  private async discover({
    scope,
    matchProvider,
    harness,
    previous = new Map(),
  }: DiscoverOptions): Promise<Map<string, KnownReport>> {
    const targets = matchProvider
      ? [...this.sources.values()].filter((source) => source.providers?.includes(matchProvider))
      : [...this.sources.values()];
    const discovered = await Promise.all(
      targets.map(async (source) => {
        const reports = new Map<string, KnownReport>();
        try {
          const accounts = z
            .array(
              z.object({
                key: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
                label: z.string().optional(),
                harness: z.string().min(1).optional(),
                provider: z.string().min(1).optional(),
                input: z.json(),
              }),
            )
            .parse(await source.discover(scope));
          for (const account of accounts) {
            const id = `${source.id}:${account.key}`;
            const known = reports.get(id);
            // COMPAT(usageLoginHarness): added in v0.11.0, remove after 2027-04-05 once plugin floor >= v0.11.0.
            const login: Login = {
              input: account.input,
              harness: harness ?? account.harness ?? source.label,
              ...(account.provider ? { provider: account.provider } : {}),
            };
            if (known) {
              if (!known.logins.some((existing) => sameLogin(existing, login)))
                known.logins.push(login);
            } else reports.set(id, { source, logins: [login], label: account.label });
          }
        } catch (error) {
          this.logger.warn({ sourceId: source.id, err: error }, "Usage source discovery failed");
          // A failed store read does not confirm removal. Agent session discovery has no previous
          // mapping because a resumed agent may use a different launch environment.
          for (const [id, report] of previous) {
            if (report.source === source) reports.set(id, report);
          }
        }
        return reports;
      }),
    );
    const merged = new Map<string, KnownReport>();
    for (const reports of discovered) {
      for (const [id, report] of reports) merged.set(id, report);
    }
    return merged;
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
        planLabel: entry.report.status === "available" ? (entry.report.planLabel ?? null) : null,
        windows: entry.report.status === "available" ? entry.report.windows : [],
        balances: entry.report.status === "available" ? (entry.report.balances ?? []) : [],
        details: entry.report.status === "available" ? (entry.report.details ?? []) : [],
        error: legacyError(entry.report, this.now()),
      })),
    };
  }

  private fetchId(id: string, known: KnownReport, forceRefresh = false): Promise<UsageReportEntry> {
    // Account identity groups cards; the ordered login set identifies a fetch result.
    const cacheKey = cacheIdentity(id, known);
    const cached = this.cache.get(cacheKey);
    if (!forceRefresh && cached && this.now() - cached.at < this.freshFor(cacheKey, cached.entry))
      return Promise.resolve(cached.entry);
    const pending = this.pending.get(cacheKey);
    if (pending) return pending;
    const request = (async () => {
      const fetchedAt = new Date(this.now()).toISOString();
      const outcome = await this.fetchWithFallback(known);
      const completedAt = new Date(this.now()).toISOString();
      const entry: UsageReportEntry = {
        id,
        sourceId: known.source.id,
        sourceLabel: known.source.label,
        icon: known.source.icon,
        account: { label: known.label },
        fetchedAt,
        ...outcome,
      };
      if (entry.report.status === "available") {
        entry.successfulAt = completedAt;
      } else {
        entry.lastSuccessful = this.successful.get(cacheKey);
      }
      if (
        this.sources.get(known.source.id) === known.source &&
        this.activeCacheKeys().has(cacheKey)
      ) {
        if (entry.report.status === "available") {
          this.successful.set(cacheKey, {
            fetchedAt: completedAt,
            report: entry.report,
          });
        }
        if (entry.report.status === "error")
          this.failures.set(cacheKey, (this.failures.get(cacheKey) ?? 0) + 1);
        else this.failures.delete(cacheKey);
        this.writeCache(cacheKey, entry);
      }
      return entry;
    })();
    this.pending.set(cacheKey, request);
    void request.finally(() => {
      if (this.pending.get(cacheKey) === request) this.pending.delete(cacheKey);
    });
    return request;
  }

  /** How long a cached entry answers: the TTL, or a backoff from 30s after consecutive errors. */
  private freshFor(cacheKey: string, entry: UsageReportEntry): number {
    if (entry.report.status !== "error") return this.ttlMs;
    const failures = Math.max(1, this.failures.get(cacheKey) ?? 1);
    return Math.min(this.ttlMs, ERROR_RETRY_MS * 2 ** (failures - 1));
  }

  private writeCache(id: string, entry: UsageReportEntry): void {
    const at = this.now();
    for (const [cachedId, cached] of this.cache) {
      if (at - cached.at >= this.ttlMs) this.cache.delete(cachedId);
    }
    this.cache.set(id, { at, entry });
  }

  private async fetchBeforeDeadline(source: UsageSource, input: unknown): Promise<UsageReport> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<UsageReport>((resolve) => {
      timer = setTimeout(
        () => resolve({ status: "error", error: "Usage fetch timed out" }),
        this.deadlineMs,
      );
    });
    try {
      return await Promise.race([this.fetchLogin(source, input), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchWithFallback(
    known: KnownReport,
  ): Promise<Pick<UsageReportEntry, "report" | "loginErrors">> {
    // Start each login within the same deadline window, then prefer discovery order.
    // Sequential deadlines can exceed the client's RPC timeout before all errors arrive.
    const attempts = known.logins.map((login) =>
      this.fetchBeforeDeadline(known.source, login.input),
    );
    const loginErrors: NonNullable<UsageReportEntry["loginErrors"]> = [];
    for (const [index, login] of known.logins.entries()) {
      const report = await attempts[index]!;
      if (report.status === "available") return { report };
      loginErrors.push({ harness: login.harness, report });
    }
    // COMPAT(usageLoginErrors): added in v0.11.0, remove after 2027-04-05 once app floor >= v0.11.0.
    // Keep the final single report so older apps still parse and display failed accounts.
    return { report: loginErrors[loginErrors.length - 1]!.report, loginErrors };
  }

  private async fetchLogin(source: UsageSource, input: unknown): Promise<UsageReport> {
    try {
      return UsageReportSchema.parse(await source.fetch(input));
    } catch (error) {
      this.logger.warn({ sourceId: source.id, err: error }, "Usage fetch failed");
      return { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }
}

// The legacy RPC has only an error string; the current app owns its own presentation.
// COMPAT(providerUsageList): added in v0.1.98, remove after 2027-03-26.
function legacyProblem(problem: UsageProblem, now: number): string {
  if (problem.kind === "no_quota") return problem.detail;
  const remedy = problem.refreshedBy
    ? `Run ${problem.refreshedBy} to refresh it.`
    : "Sign in again.";
  if (problem.kind === "rejected") return `Login rejected (HTTP ${problem.status}). ${remedy}`;
  const elapsed = Math.max(0, now - Date.parse(problem.expiresAt));
  let ago = "just now";
  if (elapsed >= 86_400_000) ago = `${Math.floor(elapsed / 86_400_000)}d ago`;
  else if (elapsed >= 3_600_000) ago = `${Math.floor(elapsed / 3_600_000)}h ago`;
  else if (elapsed >= 60_000) ago = `${Math.floor(elapsed / 60_000)}m ago`;
  return `Login expired ${ago}. ${remedy}`;
}

// COMPAT(providerUsageList): added in v0.1.98, remove after 2027-03-26.
function legacyError(report: UsageReport, now: number): string | null {
  if (report.status === "error") return report.error;
  if (report.status === "unavailable") return legacyProblem(report.problem, now);
  return null;
}

// An account found in several scopes is one report; its logins keep discovery order, once each.
function mergeReports({ into, reports }: MergeReportsOptions): void {
  for (const [id, report] of reports) {
    const known = into.get(id);
    if (!known) {
      into.set(id, { ...report, logins: [...report.logins] });
      continue;
    }
    if (!known.label && report.label) known.label = report.label;
    for (const login of report.logins) {
      const existing = known.logins.find((candidate) => sameLogin(candidate, login));
      if (!existing) {
        known.logins.push(login);
      } else if (!existing.provider && login.provider) {
        existing.provider = login.provider;
      }
    }
  }
}

function deletePrefixed(map: Map<string, unknown>, prefix: string): void {
  for (const key of map.keys()) {
    if (key.startsWith(prefix)) map.delete(key);
  }
}

/** The report with observed windows/balances/plan merged, or null when nothing matched. */
function mergeObservedReport(
  report: Extract<UsageReport, { status: "available" }>,
  observation: UsageObservation,
): Extract<UsageReport, { status: "available" }> | null {
  let matched = false;
  const windows = report.windows.map((window) => {
    const update = observation.windows.find((candidate) => candidate.id === window.id);
    if (!update || update.usedPct == null) return window;
    matched = true;
    const { runsOutAt: _runsOutAt, shortfallPct: _shortfallPct, ...rest } = window;
    return {
      ...rest,
      usedPct: update.usedPct,
      remainingPct: update.remainingPct ?? Math.max(0, 100 - update.usedPct),
      resetsAt: update.resetsAt ?? window.resetsAt ?? null,
      tone: update.tone ?? toneFromUsedPct(update.usedPct),
    };
  });
  let balances = report.balances;
  if (observation.balances?.length) {
    const next = [...(report.balances ?? [])];
    for (const update of observation.balances) {
      const idx = next.findIndex((existing) => existing.id === update.id);
      if (idx >= 0) next[idx] = update;
      else next.push(update);
      matched = true;
    }
    balances = next;
  }
  const planLabel = observation.planLabel ?? report.planLabel;
  if (!matched && (observation.planLabel === undefined || planLabel === report.planLabel)) {
    return null;
  }
  // The observation is newer than the fetch the report came from.
  const { observedAt: _observedAt, ...rest } = report;
  return {
    ...rest,
    ...(planLabel !== undefined ? { planLabel } : {}),
    windows,
    ...(balances !== undefined ? { balances } : {}),
  };
}

// Inputs are opaque JSON locators. Canonical equality deduplicates discovery across scopes.
// The harness only names a login, so the scope that finds it first decides what it is called.
function sameLogin(a: Login, b: Login): boolean {
  return canonicalJson(a.input) === canonicalJson(b.input);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) =>
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a.localeCompare(b)))
      : nested,
  );
}

function cacheIdentity(id: string, known: KnownReport): string {
  return `${id}:${createHash("sha256")
    .update(canonicalJson(known.logins.map((login) => login.input)))
    .digest("hex")}`;
}

// Labels describe the current discovery, while cached polls and history belong to login inputs.
function presentReport({ entry, known }: PresentReportOptions): UsageReportEntry {
  return {
    ...entry,
    sourceLabel: known.source.label,
    icon: known.source.icon,
    account: { label: known.label },
    ...(entry.loginErrors
      ? {
          // Errors are emitted only when every ordered login failed, so positions match inputs.
          loginErrors: entry.loginErrors.map((error, index) => ({
            ...error,
            harness: known.logins[index]?.harness ?? error.harness,
          })),
        }
      : {}),
  };
}

/** Resolves true as soon as any check resolves true, or false once every check resolves false. */
function anyTrue(checks: readonly Promise<boolean>[]): Promise<boolean> {
  if (checks.length === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let remaining = checks.length;
    let settled = false;
    for (const check of checks) {
      void (async () => {
        const value = await check;
        if (settled) return;
        if (value) {
          settled = true;
          resolve(true);
          return;
        }
        remaining -= 1;
        if (remaining === 0) {
          settled = true;
          resolve(false);
        }
      })();
    }
  });
}
