import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "pino";
import { z } from "zod";
import type { ProviderUsage, ProviderUsageBalance } from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNullableNumberSchema,
  balanceToneFromRemaining,
  fetchProviderApi,
  toIsoStringOrNull,
  unavailableUsage,
} from "../usage.js";

const execFileAsync = promisify(execFile);
const CURSOR_SQLITE_TIMEOUT_MS = 2_000;

const CursorBillingCycleTimestampSchema = z.preprocess(
  (value) => (typeof value === "string" || typeof value === "number" ? value : null),
  z.union([z.string(), z.number()]).nullable(),
);

const CursorUsageResponseSchema = z.object({
  planUsage: z
    .object({
      totalSpend: ApiNullableNumberSchema,
      includedSpend: ApiNullableNumberSchema,
      bonusSpend: ApiNullableNumberSchema,
      remaining: ApiNullableNumberSchema,
      limit: ApiNullableNumberSchema,
    })
    .nullish(),
  billingCycleStart: CursorBillingCycleTimestampSchema,
  billingCycleEnd: CursorBillingCycleTimestampSchema,
});

const CursorAuthStatusSchema = z.object({
  accessToken: z.string().optional(),
});

type CursorUsageResponse = z.infer<typeof CursorUsageResponseSchema>;

interface CursorQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
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

export class CursorQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "cursor";
  readonly displayName = "Cursor";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;

  constructor(options: CursorQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const token =
      process.env["CURSOR_ACCESS_TOKEN"] ||
      process.env["CURSOR_TOKEN"] ||
      (await readCursorTokenFromSqlite());

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
    const balances: ProviderUsageBalance[] = [];
    if (resp.planUsage) {
      const totalSpend = centsToDollars(resp.planUsage.totalSpend);
      const remaining = centsToDollars(resp.planUsage.remaining);
      const limit = centsToDollars(resp.planUsage.limit);
      balances.push({
        id: "plan_usage",
        label: "Plan usage",
        used: totalSpend,
        remaining,
        limit,
        unit: "usd",
        resetsAt: billingCycleEnd,
        tone: balanceToneFromRemaining(remaining),
      });
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: null,
      windows: [],
      balances,
      details: [],
      error: null,
    };
  }
}
