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

// cursor.com/dashboard/spending: Express/Start (India) is a single total-% bar
// (`DW` / "Monthly usage"). Pro/Pro+/Ultra and current Teams use two pools.
const SINGLE_POOL_PLAN_NAMES = new Set(["start", "express"]);

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

type CursorHardLimitResponse = z.infer<typeof CursorHardLimitResponseSchema>;

// Spending page `rz.UNLIMITED_CAP`: a hardLimit at or above this is "Unlimited".
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

function poolPercent(
  numeric: boolean,
  value: number | null,
  message: string | null | undefined,
): number | null {
  return numeric ? value : parsePercentFromMessage(message);
}

function modelPoolWindows(input: {
  resp: CursorUsageResponse;
  planName: string | null;
  resetsAt: string | null;
}): ProviderUsageWindow[] {
  const { resp, planName, resetsAt } = input;
  const planUsage = resp.planUsage;
  const totalPct = planUsage?.totalPercentUsed ?? null;

  // Official Spending `DK`: membershipType EXPRESS → one total-% bar, not the two pools.
  if (isSinglePoolPlan(planName) && totalPct != null) {
    return [monthlyUsageWindow(totalPct, resetsAt)];
  }

  const numeric = planUsage?.autoPercentUsed != null || planUsage?.apiPercentUsed != null;
  const autoPct = poolPercent(
    numeric,
    planUsage?.autoPercentUsed ?? null,
    resp.autoModelSelectedDisplayMessage,
  );
  const apiPct = poolPercent(
    numeric,
    planUsage?.apiPercentUsed ?? null,
    resp.namedModelSelectedDisplayMessage,
  );
  const windows: ProviderUsageWindow[] = [];
  for (const pool of [
    { id: "cursor_models", label: "Cursor Models", pct: autoPct },
    { id: "other_models", label: "Other Models", pct: apiPct },
  ]) {
    if (pool.pct != null) {
      windows.push(
        percentWindow({
          id: pool.id,
          label: pool.label,
          utilizationPct: pool.pct,
          resetsAt,
        }),
      );
    }
  }
  if (windows.length > 0) return windows;

  // Express/Start without a plan name, or a payload that only has the combined %.
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
  hasWindows: boolean;
  resetsAt: string | null;
}): ProviderUsageBalance[] {
  const { resp, hasWindows, resetsAt } = input;
  // Official Spending never mixes included-% bars with planUsage dollars. Those
  // cents include bonus/on-demand and are what used to render as `$135 / $20`.
  if (hasWindows) return [];

  const balances: ProviderUsageBalance[] = [];
  if (resp.planUsage) {
    appendUsdBalance(balances, {
      id: "plan_usage",
      label: "Plan usage",
      usedCents: resp.planUsage.totalSpend,
      remainingCents: resp.planUsage.remaining,
      limitCents: resp.planUsage.limit,
      resetsAt,
    });
  }

  const spend = resp.spendLimitUsage;
  if (spend?.pooledLimit != null) {
    appendUsdBalance(balances, {
      id: "team_usage",
      label: "Team usage",
      usedCents: spend.pooledUsed,
      remainingCents: spend.pooledRemaining,
      limitCents: spend.pooledLimit,
      resetsAt,
    });
  }

  return balances;
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

// cursor.com/dashboard/spending On-Demand cell (`DK`):
// noUsageBasedAllowed / hardLimit === "no-usage-based" → "Disabled"
// unlimited → "$used"; fixed → "$used / $limit" (used is cents, limit is dollars).
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
    return null; // runtime without node:sqlite
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

    const [resp, planName, hardLimit] = await Promise.all([
      this.fetchCurrentPeriodUsage(token),
      this.fetchPlanName(token),
      this.fetchHardLimit(token),
    ]);
    if (!resp) return unavailableUsage(this);

    // cursor.com/dashboard/spending Included usage: `Dq(planUsage)` → two %
    // bars (personal `DK` and current Teams `DY`). Dollars are on-demand/admin,
    // not this card. Fall back to cents only when the API has no percentages.
    const billingCycleEnd = parseCursorBillingCycleTimestamp(resp.billingCycleEnd);
    const windows = modelPoolWindows({ resp, planName, resetsAt: billingCycleEnd });
    const includedBalances = dollarBalances({
      resp,
      hasWindows: windows.length > 0,
      resetsAt: billingCycleEnd,
    });
    // Start/Express hides the On-Demand section (`!b && !B` in `DK`).
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
      balances: [...includedBalances, ...onDemand.balances],
      details: onDemand.details,
      error: null,
    };
  }

  private cursorDashboardRequest(token: string, method: string): Promise<Response> {
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
        body: JSON.stringify({}),
      },
    );
  }

  // Enrichment RPCs must not hide included usage from GetCurrentPeriodUsage.
  private async fetchOptionalDashboard<T>(
    token: string,
    method: string,
    schema: z.ZodType<T>,
  ): Promise<T | null> {
    try {
      const res = await this.cursorDashboardRequest(token, method);
      if (!res.ok) return null;
      const parsed = schema.safeParse(await res.json());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async fetchCurrentPeriodUsage(token: string): Promise<CursorUsageResponse | null> {
    const res = await this.cursorDashboardRequest(token, "GetCurrentPeriodUsage");
    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Cursor usage fetch failed");
      return null;
    }
    return CursorUsageResponseSchema.parse(await res.json());
  }

  private fetchHardLimit(token: string): Promise<CursorHardLimitResponse | null> {
    return this.fetchOptionalDashboard(token, "GetHardLimit", CursorHardLimitResponseSchema);
  }

  private async fetchPlanName(token: string): Promise<string | null> {
    const parsed = await this.fetchOptionalDashboard(
      token,
      "GetPlanInfo",
      CursorPlanInfoResponseSchema,
    );
    return parsed?.planInfo?.planName?.trim() || null;
  }
}
