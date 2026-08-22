import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageDetail,
  ProviderUsageWindow,
} from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNullableNumberSchema,
  balanceToneFromRemaining,
  toneFromUsedPct,
  usedPctOf,
  fetchProviderApi,
  toIsoStringOrNull,
  unavailableUsage,
  windowFromUsedPct,
} from "../usage.js";

// Cursor desktop stores auth in VS Code's ItemTable (state.vscdb). Modern builds keep
// the access token as a plain JWT string under `cursorAuth/accessToken`; older builds
// kept a JSON blob under `cursorAuthStatus`. Read it with node:sqlite so we don't
// depend on a `sqlite3` CLI, which isn't installed by default on Windows (or on many
// Linux hosts) — a missing binary silently rendered Cursor usage unavailable.
// Headless hosts (VPS, cursor-agent only) have no desktop db; their session lives in
// ~/.config/cursor/auth.json instead.
const CURSOR_ACCESS_TOKEN_KEY = "cursorAuth/accessToken";
const CURSOR_LEGACY_AUTH_KEY = "cursorAuthStatus";

// @types/node@20 predates the node:sqlite typings; declare the slice we use.
interface CursorStateStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
}
interface CursorStateDatabase {
  prepare(sql: string): CursorStateStatement;
  close(): void;
}
interface NodeSqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => CursorStateDatabase;
}

const CursorBillingCycleTimestampSchema = z.preprocess(
  (value) => (typeof value === "string" || typeof value === "number" ? value : null),
  z.union([z.string(), z.number()]).nullable(),
);

const SINGLE_POOL_PLAN_NAMES = new Set(["start", "express"]);

// Request-based included usage is 500 requests per seat, at $0.04 each.
const INCLUDED_REQUESTS_PER_SEAT = 500;
const CENTS_PER_INCLUDED_REQUEST = 4;
const FREE_OWNER_ROLES = new Set(["FREE_OWNER", "TEAM_ROLE_FREE_OWNER"]);

const CursorPlanUsageSchema = z.object({
  totalSpend: ApiNullableNumberSchema,
  includedSpend: ApiNullableNumberSchema,
  bonusSpend: ApiNullableNumberSchema,
  remaining: ApiNullableNumberSchema,
  limit: ApiNullableNumberSchema,
  autoPercentUsed: ApiNullableNumberSchema,
  apiPercentUsed: ApiNullableNumberSchema,
  totalPercentUsed: ApiNullableNumberSchema,
});

const CursorSpendLimitUsageSchema = z.object({
  totalSpend: ApiNullableNumberSchema,
  pooledLimit: ApiNullableNumberSchema,
  pooledUsed: ApiNullableNumberSchema,
  pooledRemaining: ApiNullableNumberSchema,
  individualLimit: ApiNullableNumberSchema,
  individualUsed: ApiNullableNumberSchema,
  individualRemaining: ApiNullableNumberSchema,
  limitType: z.string().nullish(),
});

const CursorUsageResponseSchema = z.object({
  planUsage: CursorPlanUsageSchema.nullish(),
  spendLimitUsage: CursorSpendLimitUsageSchema.nullish(),
  billingCycleStart: CursorBillingCycleTimestampSchema,
  billingCycleEnd: CursorBillingCycleTimestampSchema,
  autoModelSelectedDisplayMessage: z.string().nullish(),
  namedModelSelectedDisplayMessage: z.string().nullish(),
});

const CursorPlanInfoResponseSchema = z.object({
  planInfo: z
    .object({
      planName: z.string().optional(),
    })
    .nullish(),
});

const CursorHardLimitResponseSchema = z.object({
  noUsageBasedAllowed: z.boolean().optional(),
  hardLimit: z.union([z.number(), z.string()]).optional(),
});

const CursorTeamSchema = z.object({
  id: ApiNullableNumberSchema,
  name: z.string().optional(),
  role: z.string().optional(),
  requestQuotaPerSeat: ApiNullableNumberSchema,
  selfServeTieredPricingEnabled: z.boolean().optional(),
  pricingStrategy: z.string().optional(),
});

const CursorTeamsResponseSchema = z.object({
  teams: z.array(CursorTeamSchema).nullish(),
});

type CursorHardLimitResponse = z.infer<typeof CursorHardLimitResponseSchema>;
type CursorTeam = z.infer<typeof CursorTeamSchema>;
type CursorTeamWithId = CursorTeam & { id: number };

const CURSOR_UNLIMITED_HARD_LIMIT = 100_000_000;
const ON_DEMAND_LABEL = "On-Demand Spending";

const CursorAuthStatusSchema = z.object({
  accessToken: z.string().optional(),
});

type CursorUsageResponse = z.infer<typeof CursorUsageResponseSchema>;
type CursorSpendLimitUsage = NonNullable<CursorUsageResponse["spendLimitUsage"]>;

interface CursorQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  homeDir?: string;
}

function parseCursorBillingCycleTimestamp(
  value: CursorUsageResponse["billingCycleStart"],
): string | null {
  if (value === null) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    const timestampMs = Math.abs(numeric) < 10_000_000_000 ? numeric * 1000 : numeric;
    return toIsoStringOrNull(timestampMs);
  }

  return toIsoStringOrNull(new Date(raw).getTime());
}

function centsToDollars(value: number | null): number | null {
  return value === null ? null : value / 100;
}

function parsePercentFromMessage(message: string | null | undefined): number | null {
  if (!message) return null;
  const match = message.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function isSinglePoolPlan(planName: string | null): boolean {
  const name = planName?.trim().toLowerCase();
  return name != null && SINGLE_POOL_PLAN_NAMES.has(name);
}

function isFreeOwnerRole(role: string | undefined): boolean {
  return role != null && FREE_OWNER_ROLES.has(role);
}

function isCurrentTokenTeam(team: CursorTeam | null): boolean {
  return team != null && team.selfServeTieredPricingEnabled === true && !isFreeOwnerRole(team.role);
}

// Token-priced teams without the current per-seat pools use a dollar included
// meter. Everything else on a team is the older request-based included quota.
function isRequestBasedTeam(team: CursorTeam | null): boolean {
  if (team == null || isCurrentTokenTeam(team)) return false;
  return team.pricingStrategy !== "tokens";
}

function usableTeam(team: CursorTeam | null): CursorTeamWithId | null {
  if (team == null || team.id == null) return null;
  return { ...team, id: team.id };
}

function requestCountFromSpendCents(cents: number): number {
  return Math.ceil(cents / CENTS_PER_INCLUDED_REQUEST);
}

function percentWindow(input: {
  id: string;
  label: string;
  utilizationPct: number;
  resetsAt: string | null;
}): ProviderUsageWindow {
  return windowFromUsedPct({
    id: input.id,
    label: input.label,
    utilizationPct: input.utilizationPct,
    resetsAt: input.resetsAt,
    tone: toneFromUsedPct(input.utilizationPct),
  });
}

function monthlyUsageWindow(utilizationPct: number, resetsAt: string | null): ProviderUsageWindow {
  return percentWindow({
    id: "monthly_usage",
    label: "Monthly usage",
    utilizationPct,
    resetsAt,
  });
}

function poolPercent(input: {
  value: number | null;
  message: string | null | undefined;
  numeric: boolean;
  fillMissingZeros: boolean;
}): number | null {
  if (input.fillMissingZeros) return input.value ?? 0;
  if (input.numeric) return input.value;
  return parsePercentFromMessage(input.message);
}

function modelPoolWindows(input: {
  resp: CursorUsageResponse;
  planName: string | null;
  resetsAt: string | null;
  fillMissingZeros?: boolean;
}): ProviderUsageWindow[] {
  const { resp, planName, resetsAt, fillMissingZeros = false } = input;
  const planUsage = resp.planUsage;
  const totalPct = planUsage?.totalPercentUsed ?? null;

  if (isSinglePoolPlan(planName) && totalPct != null) {
    return [monthlyUsageWindow(totalPct, resetsAt)];
  }

  const numeric =
    fillMissingZeros || planUsage?.autoPercentUsed != null || planUsage?.apiPercentUsed != null;
  const windows: ProviderUsageWindow[] = [];
  for (const pool of [
    {
      id: "cursor_models",
      label: "Cursor Models",
      value: planUsage?.autoPercentUsed ?? null,
      message: resp.autoModelSelectedDisplayMessage,
    },
    {
      id: "other_models",
      label: "Other Models",
      value: planUsage?.apiPercentUsed ?? null,
      message: resp.namedModelSelectedDisplayMessage,
    },
  ]) {
    const pct = poolPercent({
      value: pool.value,
      message: pool.message,
      numeric,
      fillMissingZeros,
    });
    if (pct == null) continue;
    windows.push(
      percentWindow({
        id: pool.id,
        label: pool.label,
        utilizationPct: pct,
        resetsAt,
      }),
    );
  }
  if (windows.length > 0) return windows;
  if (totalPct != null) return [monthlyUsageWindow(totalPct, resetsAt)];
  return [];
}

function usdBalance(input: {
  id: string;
  label: string;
  usedCents: number | null;
  remainingCents: number | null;
  limitCents: number | null;
  resetsAt: string | null;
}): ProviderUsageBalance | null {
  const used = centsToDollars(input.usedCents);
  const remaining = centsToDollars(input.remainingCents);
  const limit = centsToDollars(input.limitCents);
  if (used == null && remaining == null && limit == null) return null;

  const usedPct = usedPctOf(used, limit);
  return {
    id: input.id,
    label: input.label,
    used,
    remaining,
    limit,
    unit: "usd",
    resetsAt: input.resetsAt,
    tone: usedPct != null ? toneFromUsedPct(usedPct) : balanceToneFromRemaining(remaining),
  };
}

function appendUsdBalance(
  balances: ProviderUsageBalance[],
  input: Parameters<typeof usdBalance>[0],
): void {
  const balance = usdBalance(input);
  if (balance) balances.push(balance);
}

function dollarBalances(input: {
  resp: CursorUsageResponse;
  resetsAt: string | null;
}): ProviderUsageBalance[] {
  const { resp, resetsAt } = input;
  const balances: ProviderUsageBalance[] = [];
  if (resp.planUsage) {
    appendUsdBalance(balances, {
      id: "included_usage",
      label: "Your included usage",
      usedCents: resp.planUsage.totalSpend,
      remainingCents: resp.planUsage.remaining,
      limitCents: resp.planUsage.limit,
      resetsAt,
    });
  } else if (resp.spendLimitUsage?.individualUsed != null) {
    appendUsdBalance(balances, {
      id: "monthly_usage_usd",
      label: "Your monthly usage",
      usedCents: resp.spendLimitUsage.individualUsed,
      remainingCents: resp.spendLimitUsage.individualRemaining ?? null,
      limitCents: resp.spendLimitUsage.individualLimit ?? null,
      resetsAt,
    });
  }

  return balances;
}

function includedRequestBalance(input: {
  team: CursorTeam;
  resp: CursorUsageResponse;
  resetsAt: string | null;
}): ProviderUsageBalance | null {
  const quota = input.team.requestQuotaPerSeat;
  const limit = quota != null && quota > 0 ? INCLUDED_REQUESTS_PER_SEAT * quota : null;
  const planUsedCents =
    input.resp.planUsage?.includedSpend ?? input.resp.planUsage?.totalSpend ?? null;
  const used =
    planUsedCents != null && planUsedCents > 0 ? requestCountFromSpendCents(planUsedCents) : 0;
  if (limit == null && (planUsedCents == null || planUsedCents <= 0)) return null;

  const capped = limit != null ? Math.min(used, limit) : used;
  const remaining = limit != null ? Math.max(0, limit - capped) : null;
  const usedPct = usedPctOf(capped, limit);
  return {
    id: "included_requests",
    label: "Included-Request Usage",
    used: capped,
    remaining,
    limit,
    unit: "requests",
    resetsAt: input.resetsAt,
    tone: usedPct != null ? toneFromUsedPct(usedPct) : balanceToneFromRemaining(remaining),
  };
}

function includedBalances(input: {
  team: CursorTeamWithId | null;
  resp: CursorUsageResponse;
  windows: ProviderUsageWindow[];
  billingCycleEnd: string | null;
}): ProviderUsageBalance[] {
  if (input.windows.length > 0) return [];
  if (input.team && isRequestBasedTeam(input.team)) {
    const request = includedRequestBalance({
      team: input.team,
      resp: input.resp,
      resetsAt: input.billingCycleEnd,
    });
    return request ? [request] : [];
  }
  return dollarBalances({ resp: input.resp, resetsAt: input.billingCycleEnd });
}

function numericHardLimitDollars(hardLimit: CursorHardLimitResponse["hardLimit"]): number | null {
  if (typeof hardLimit === "number" && Number.isFinite(hardLimit)) return hardLimit;
  if (typeof hardLimit === "string") {
    const value = Number(hardLimit);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

function isOnDemandDisabled(hardLimit: CursorHardLimitResponse | null): boolean {
  return hardLimit?.noUsageBasedAllowed === true || hardLimit?.hardLimit === "no-usage-based";
}

function onDemandLimitCents(
  limitDollars: number | null,
  spend: CursorSpendLimitUsage | null | undefined,
): number | null {
  if (limitDollars != null && limitDollars >= CURSOR_UNLIMITED_HARD_LIMIT) return null;
  if (limitDollars != null && limitDollars > 0) return limitDollars * 100;
  const spendLimitCents = spend?.individualLimit;
  return spendLimitCents != null && spendLimitCents > 0 ? spendLimitCents : null;
}

function onDemandUsage(input: {
  hardLimit: CursorHardLimitResponse | null;
  spend: CursorSpendLimitUsage | null | undefined;
  resetsAt: string | null;
}): { balances: ProviderUsageBalance[]; details: ProviderUsageDetail[] } {
  const { hardLimit, spend, resetsAt } = input;
  if (isOnDemandDisabled(hardLimit)) {
    return {
      balances: [],
      details: [{ id: "on_demand", label: ON_DEMAND_LABEL, value: "Disabled" }],
    };
  }

  const limitDollars = numericHardLimitDollars(hardLimit?.hardLimit);
  const unlimited = limitDollars != null && limitDollars >= CURSOR_UNLIMITED_HARD_LIMIT;
  const limitCents = onDemandLimitCents(limitDollars, spend);
  const enabled =
    limitCents != null ||
    unlimited ||
    spend?.individualUsed != null ||
    hardLimit?.noUsageBasedAllowed === false;
  if (!enabled) return { balances: [], details: [] };

  const balances: ProviderUsageBalance[] = [];
  appendUsdBalance(balances, {
    id: "on_demand",
    label: ON_DEMAND_LABEL,
    usedCents: spend?.individualUsed ?? 0,
    remainingCents: limitCents == null ? null : (spend?.individualRemaining ?? null),
    limitCents,
    resetsAt,
  });
  return { balances, details: [] };
}

function readItemTableValue(db: CursorStateDatabase, key: string): string | null {
  const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key);
  const value = row?.["value"];
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return null;
}

function cursorTokenFromDb(db: CursorStateDatabase): string | null {
  const modern = readItemTableValue(db, CURSOR_ACCESS_TOKEN_KEY)?.trim();
  if (modern) return modern;

  const legacy = readItemTableValue(db, CURSOR_LEGACY_AUTH_KEY);
  if (legacy) {
    try {
      const parsed = CursorAuthStatusSchema.parse(JSON.parse(legacy));
      if (parsed.accessToken) return parsed.accessToken;
    } catch {
      // ignore a malformed legacy blob
    }
  }
  return null;
}

async function readCursorTokenFromSqlite(homeDir: string, logger: Logger): Promise<string | null> {
  const dbPaths: string[] = [];
  if (process.env["APPDATA"]) {
    dbPaths.push(join(process.env["APPDATA"], "Cursor", "User", "globalStorage", "state.vscdb"));
  }
  dbPaths.push(
    join(
      homeDir,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    ),
  );
  dbPaths.push(join(homeDir, ".config", "Cursor", "User", "globalStorage", "state.vscdb"));

  // Held in a variable so TypeScript skips module resolution: @types/node@20 has no
  // node:sqlite typings yet, while the runtime (Node 22+ / Electron) provides it.
  const sqliteSpecifier: string = "node:sqlite";
  let sqlite: NodeSqliteModule;
  try {
    sqlite = (await import(sqliteSpecifier)) as unknown as NodeSqliteModule;
  } catch (err) {
    logger.debug({ err }, "node:sqlite unavailable; cannot read Cursor state.vscdb");
    return null;
  }

  for (const path of dbPaths) {
    if (!existsSync(path)) continue;
    let db: CursorStateDatabase | undefined;
    try {
      db = new sqlite.DatabaseSync(path, { readOnly: true });
      const token = cursorTokenFromDb(db);
      if (token) return token;
    } catch (err) {
      // Locked/permission/corrupt/schema failures all land here; log so an
      // unavailable Cursor card is diagnosable, then try the next candidate.
      logger.debug({ err, path }, "Failed to read Cursor token from state.vscdb");
    } finally {
      db?.close();
    }
  }
  return null;
}

async function readCursorTokenFromAuthJson(
  homeDir: string,
  logger: Logger,
): Promise<string | null> {
  const path = join(homeDir, ".config", "cursor", "auth.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = CursorAuthStatusSchema.parse(JSON.parse(await readFile(path, "utf8")));
    return parsed.accessToken?.trim() || null;
  } catch (err) {
    logger.debug({ err, path }, "Failed to read Cursor token from auth.json");
    return null;
  }
}

export class CursorQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "cursor";
  readonly displayName = "Cursor";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly homeDir: string;

  constructor(options: CursorQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
    this.homeDir = options.homeDir ?? homedir();
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const token =
      process.env["CURSOR_ACCESS_TOKEN"] ||
      process.env["CURSOR_TOKEN"] ||
      (await readCursorTokenFromSqlite(this.homeDir, this.logger)) ||
      (await readCursorTokenFromAuthJson(this.homeDir, this.logger));

    if (!token) return unavailableUsage(this);

    const team = usableTeam(await this.fetchTeam(token));
    const [resp, planName, hardLimit] = await Promise.all([
      this.fetchCurrentPeriodUsage(token, team?.id ?? null),
      this.fetchPlanName(token),
      this.fetchHardLimit(token),
    ]);
    if (!resp) return unavailableUsage(this);

    const billingCycleEnd = parseCursorBillingCycleTimestamp(resp.billingCycleEnd);
    const windows = modelPoolWindows({
      resp,
      planName,
      resetsAt: billingCycleEnd,
      fillMissingZeros: isCurrentTokenTeam(team),
    });
    const onDemand = isSinglePoolPlan(planName)
      ? { balances: [], details: [] }
      : onDemandUsage({
          hardLimit,
          spend: resp.spendLimitUsage,
          resetsAt: billingCycleEnd,
        });

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: planName,
      windows,
      balances: [
        ...includedBalances({ team, resp, windows, billingCycleEnd }),
        ...onDemand.balances,
      ],
      details: onDemand.details,
      error: null,
    };
  }

  private cursorDashboardRequest(
    token: string,
    method: string,
    body: Record<string, unknown> = {},
  ): Promise<Response> {
    return fetchProviderApi(
      this.fetchApi,
      `https://api2.cursor.sh/aiserver.v1.DashboardService/${method}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
        },
        body: JSON.stringify(body),
      },
    );
  }

  // Plan name / hard limit / team lookup must not hide included usage if they fail.
  private async fetchOptionalDashboard<T>(input: {
    token: string;
    method: string;
    schema: z.ZodType<T>;
  }): Promise<T | null> {
    try {
      const res = await this.cursorDashboardRequest(input.token, input.method);
      if (!res.ok) return null;
      const parsed = input.schema.safeParse(await res.json());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async fetchCurrentPeriodUsage(
    token: string,
    teamId: number | null,
  ): Promise<CursorUsageResponse | null> {
    const res = await this.cursorDashboardRequest(
      token,
      "GetCurrentPeriodUsage",
      // Team seats only populate period usage when the request is scoped to the team.
      teamId == null ? {} : { teamId },
    );
    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Cursor usage fetch failed");
      return null;
    }
    return CursorUsageResponseSchema.parse(await res.json());
  }

  private fetchHardLimit(token: string): Promise<CursorHardLimitResponse | null> {
    return this.fetchOptionalDashboard({
      token,
      method: "GetHardLimit",
      schema: CursorHardLimitResponseSchema,
    });
  }

  private async fetchPlanName(token: string): Promise<string | null> {
    const parsed = await this.fetchOptionalDashboard({
      token,
      method: "GetPlanInfo",
      schema: CursorPlanInfoResponseSchema,
    });
    return parsed?.planInfo?.planName?.trim() || null;
  }

  private async fetchTeam(token: string): Promise<CursorTeam | null> {
    const parsed = await this.fetchOptionalDashboard({
      token,
      method: "GetTeams",
      schema: CursorTeamsResponseSchema,
    });
    return parsed?.teams?.[0] ?? null;
  }
}
