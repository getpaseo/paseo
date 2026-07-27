import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
  toneFromUsedPct,
  usedPctOf,
  fetchProviderApi,
  toIsoStringOrNull,
  unavailableUsage,
  windowFromUsedPct,
} from "../usage.js";

const execFileAsync = promisify(execFile);
const CURSOR_SQLITE_TIMEOUT_MS = 2_000;

const CursorBillingCycleTimestampSchema = z.preprocess(
  (value) => (typeof value === "string" || typeof value === "number" ? value : null),
  z.union([z.string(), z.number()]).nullable(),
);

const CursorPlanUsageSchema = z.object({
  // Dollar fields are retail API-cost estimates in cents. Quota gating uses the
  // percent fields; totalSpend = includedSpend + bonusSpend and must not be the
  // "used" side of the plan-limit bar.
  totalSpend: ApiNullableNumberSchema,
  includedSpend: ApiNullableNumberSchema,
  bonusSpend: ApiNullableNumberSchema,
  remaining: ApiNullableNumberSchema,
  limit: ApiNullableNumberSchema,
  autoPercentUsed: ApiNullableNumberSchema.optional(),
  apiPercentUsed: ApiNullableNumberSchema.optional(),
  totalPercentUsed: ApiNullableNumberSchema.optional(),
});

const CursorUsageResponseSchema = z.object({
  planUsage: CursorPlanUsageSchema.nullish(),
  billingCycleStart: CursorBillingCycleTimestampSchema,
  billingCycleEnd: CursorBillingCycleTimestampSchema,
});

const CursorAuthStatusSchema = z.object({
  accessToken: z.string().optional(),
});

const CursorAuthJsonSchema = z.object({
  accessToken: z.string().min(1),
});

type CursorPlanUsage = z.infer<typeof CursorPlanUsageSchema>;
type CursorUsageResponse = z.infer<typeof CursorUsageResponseSchema>;

interface CursorQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  /** Test seam for token discovery. */
  resolveAccessToken?: () => Promise<string | null>;
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

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatUsdDetail(cents: number): string {
  return `$${centsToDollars(cents)!.toFixed(2)}`;
}

function readFinitePercent(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Map Cursor planUsage onto Paseo balances/windows.
 *
 * Cursor's Ultra dashboard is percentage-first (Total / First-party / API). The
 * dollar bar for the "$400 API included" rail is attributed as
 * `limit × apiPercentUsed / 100` — not raw includedSpend/totalSpend. Those cent
 * fields mix retail cost and free bonus and often pin includedSpend to the
 * limit even while API % is still well below 100.
 */
export function normalizeCursorPlanUsage(
  planUsage: CursorPlanUsage,
  billingCycleEnd: string | null,
): {
  balances: ProviderUsageBalance[];
  windows: ProviderUsageWindow[];
  details: ProviderUsageDetail[];
} {
  const limit = centsToDollars(planUsage.limit);
  const apiPercent = readFinitePercent(planUsage.apiPercentUsed);
  const totalPercent = readFinitePercent(planUsage.totalPercentUsed);
  const autoPercent = readFinitePercent(planUsage.autoPercentUsed);

  const windows: ProviderUsageWindow[] = [];
  const percentWindows: Array<{
    id: string;
    label: string;
    value: number | null;
  }> = [
    { id: "total_usage", label: "Total", value: totalPercent },
    { id: "auto_usage", label: "First-party models", value: autoPercent },
    { id: "api_usage", label: "API", value: apiPercent },
  ];
  for (const window of percentWindows) {
    if (window.value == null) continue;
    windows.push(
      windowFromUsedPct({
        id: window.id,
        label: window.label,
        utilizationPct: window.value,
        resetsAt: billingCycleEnd,
        tone: toneFromUsedPct(window.value),
      }),
    );
  }

  const balances: ProviderUsageBalance[] = [];
  if (limit != null && limit > 0 && apiPercent != null) {
    const used = roundUsd((limit * apiPercent) / 100);
    balances.push({
      id: "plan_usage",
      label: "API",
      used,
      remaining: roundUsd(Math.max(0, limit - used)),
      limit,
      unit: "usd",
      resetsAt: billingCycleEnd,
      tone: toneFromUsedPct(apiPercent),
    });
  } else if (limit != null && limit > 0 && totalPercent != null) {
    const used = roundUsd((limit * totalPercent) / 100);
    balances.push({
      id: "plan_usage",
      label: "Plan usage",
      used,
      remaining: roundUsd(Math.max(0, limit - used)),
      limit,
      unit: "usd",
      resetsAt: billingCycleEnd,
      tone: toneFromUsedPct(totalPercent),
    });
  } else {
    const includedSpend = centsToDollars(planUsage.includedSpend);
    const remainingFromApi = centsToDollars(planUsage.remaining);
    const remaining =
      remainingFromApi ??
      (includedSpend != null && limit != null ? Math.max(0, limit - includedSpend) : null);
    if (includedSpend != null || limit != null || remaining != null) {
      balances.push({
        id: "plan_usage",
        label: "Plan usage",
        used: includedSpend,
        remaining,
        limit,
        unit: "usd",
        resetsAt: billingCycleEnd,
        tone: toneFromUsedPct(usedPctOf(includedSpend, limit)),
      });
    }
  }

  const details: ProviderUsageDetail[] = [];
  if (typeof planUsage.bonusSpend === "number" && planUsage.bonusSpend > 0) {
    details.push({
      id: "bonus_spend",
      label: "Bonus usage",
      value: formatUsdDetail(planUsage.bonusSpend),
    });
  }

  return { balances, windows, details };
}

async function readCursorTokenFromSqlite(): Promise<string | null> {
  const dbPaths: string[] = [];
  if (process.env["APPDATA"]) {
    dbPaths.push(join(process.env["APPDATA"], "Cursor", "User", "globalStorage", "state.vscdb"));
  }
  dbPaths.push(
    join(
      homedir(),
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    ),
  );
  dbPaths.push(join(homedir(), ".config", "Cursor", "User", "globalStorage", "state.vscdb"));

  for (const path of dbPaths) {
    if (!existsSync(path)) continue;
    try {
      const { stdout } = await execFileAsync(
        "sqlite3",
        [path, "SELECT value FROM ItemTable WHERE key = 'cursorAuthStatus'"],
        { timeout: CURSOR_SQLITE_TIMEOUT_MS },
      );
      if (stdout) {
        const parsed = CursorAuthStatusSchema.parse(JSON.parse(stdout.trim()));
        if (parsed.accessToken) return parsed.accessToken;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** Cursor Agent CLI stores session tokens at `~/.config/cursor/auth.json`. */
export async function readCursorTokenFromAuthJson(
  home: string = homedir(),
): Promise<string | null> {
  const path = join(home, ".config", "cursor", "auth.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = CursorAuthJsonSchema.parse(JSON.parse(await readFile(path, "utf8")));
    return parsed.accessToken;
  } catch {
    return null;
  }
}

export async function resolveCursorAccessToken(): Promise<string | null> {
  return (
    process.env["CURSOR_ACCESS_TOKEN"] ||
    process.env["CURSOR_TOKEN"] ||
    (await readCursorTokenFromSqlite()) ||
    (await readCursorTokenFromAuthJson())
  );
}

export class CursorQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "cursor";
  readonly displayName = "Cursor";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly resolveAccessToken: () => Promise<string | null>;

  constructor(options: CursorQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
    this.resolveAccessToken = options.resolveAccessToken ?? resolveCursorAccessToken;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const token = await this.resolveAccessToken();

    if (!token) return unavailableUsage(this);

    const res = await fetchProviderApi(
      this.fetchApi,
      "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
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

    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Cursor usage fetch failed");
      return unavailableUsage(this);
    }

    const resp = CursorUsageResponseSchema.parse(await res.json());
    const billingCycleEnd = parseCursorBillingCycleTimestamp(resp.billingCycleEnd);
    const planLabel = await this.fetchPlanLabel(token);
    if (!resp.planUsage) {
      return {
        providerId: this.providerId,
        displayName: this.displayName,
        status: "available",
        planLabel,
        windows: [],
        balances: [],
        details: [],
        error: null,
      };
    }

    const { balances, windows, details } = normalizeCursorPlanUsage(
      resp.planUsage,
      billingCycleEnd,
    );

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel,
      windows,
      balances,
      details,
      error: null,
    };
  }

  private async fetchPlanLabel(token: string): Promise<string | null> {
    try {
      const res = await fetchProviderApi(
        this.fetchApi,
        "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo",
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
      if (!res.ok) return null;
      const parsed = z
        .object({
          planInfo: z
            .object({
              planName: z.string().min(1).optional(),
            })
            .optional(),
        })
        .parse(await res.json());
      return parsed.planInfo?.planName ?? null;
    } catch {
      return null;
    }
  }
}
