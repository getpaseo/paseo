import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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
  ApiNumberSchema,
  toneFromUsedPct,
  usedPctOf,
  fetchProviderApi,
  toIsoStringOrNull,
  unavailableUsage,
  windowFromUsedPct,
} from "../usage.js";

const execFileAsync = promisify(execFile);
const CURSOR_SQLITE_TIMEOUT_MS = 2_000;

/** Keys Cursor has used for the desktop access token in state.vscdb. */
const CURSOR_ACCESS_TOKEN_KEYS = ["cursorAuth/accessToken", "cursorAuthStatus"] as const;
const CURSOR_PLAN_KEY = "cursorAuth/stripeMembershipType";

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
      // Present on older API responses; current dashboard responses omit it.
      remaining: ApiNullableNumberSchema,
      limit: ApiNullableNumberSchema,
      autoPercentUsed: ApiNumberSchema.optional(),
      apiPercentUsed: ApiNumberSchema.optional(),
      totalPercentUsed: ApiNumberSchema.optional(),
    })
    .nullish(),
  billingCycleStart: CursorBillingCycleTimestampSchema,
  billingCycleEnd: CursorBillingCycleTimestampSchema,
  displayMessage: z.string().optional(),
});

const CursorAuthStatusSchema = z.object({
  accessToken: z.string().optional(),
});

type CursorUsageResponse = z.infer<typeof CursorUsageResponseSchema>;

interface CursorQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  /** Override home directory (tests). Production uses os.homedir(). */
  homeDir?: string;
}

interface CursorSqliteAuth {
  accessToken: string | null;
  planLabel: string | null;
}

/**
 * Resolve a Cursor access token from state.vscdb row values.
 * Prefers the modern plain-string key; falls back to legacy JSON cursorAuthStatus.
 */
export function extractCursorAccessToken(
  rows: ReadonlyArray<{ key: string; value: string }>,
): string | null {
  for (const row of rows) {
    if (row.key !== "cursorAuth/accessToken") continue;
    const token = row.value.trim();
    if (token.length > 0) return token;
  }

  for (const row of rows) {
    if (row.key !== "cursorAuthStatus") continue;
    try {
      const parsed = CursorAuthStatusSchema.parse(JSON.parse(row.value.trim()));
      if (parsed.accessToken && parsed.accessToken.length > 0) return parsed.accessToken;
    } catch {
      // Malformed legacy JSON — try other rows.
    }
  }

  return null;
}

export function extractCursorPlanLabel(
  rows: ReadonlyArray<{ key: string; value: string }>,
): string | null {
  for (const row of rows) {
    if (row.key !== CURSOR_PLAN_KEY) continue;
    const plan = row.value.trim();
    if (!plan) return null;
    return plan.charAt(0).toUpperCase() + plan.slice(1);
  }
  return null;
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

function cursorStateDbPaths(homeDir: string): string[] {
  const paths: string[] = [];
  if (process.env["APPDATA"]) {
    paths.push(join(process.env["APPDATA"], "Cursor", "User", "globalStorage", "state.vscdb"));
  }
  paths.push(
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
  paths.push(join(homeDir, ".config", "Cursor", "User", "globalStorage", "state.vscdb"));
  return paths;
}

function parseSqliteKeyValueRows(stdout: string): Array<{ key: string; value: string }> {
  const rows: Array<{ key: string; value: string }> = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("|");
    if (separator <= 0) continue;
    rows.push({
      key: trimmed.slice(0, separator),
      value: trimmed.slice(separator + 1),
    });
  }
  return rows;
}

async function readCursorAuthFromSqlite(homeDir: string): Promise<CursorSqliteAuth> {
  const keys = [...CURSOR_ACCESS_TOKEN_KEYS, CURSOR_PLAN_KEY]
    .map((key) => `'${key.replace(/'/g, "''")}'`)
    .join(", ");
  const query = `SELECT key, value FROM ItemTable WHERE key IN (${keys});`;

  for (const path of cursorStateDbPaths(homeDir)) {
    if (!existsSync(path)) continue;
    try {
      const { stdout } = await execFileAsync("sqlite3", [path, query], {
        timeout: CURSOR_SQLITE_TIMEOUT_MS,
      });
      const rows = parseSqliteKeyValueRows(stdout);
      const accessToken = extractCursorAccessToken(rows);
      if (!accessToken) continue;
      return {
        accessToken,
        planLabel: extractCursorPlanLabel(rows),
      };
    } catch {
      continue;
    }
  }

  return { accessToken: null, planLabel: null };
}

function buildCursorWindows(
  planUsage: NonNullable<CursorUsageResponse["planUsage"]>,
  resetsAt: string | null,
): ProviderUsageWindow[] {
  const windows: ProviderUsageWindow[] = [];
  const specs: Array<{ id: string; label: string; value: number | undefined }> = [
    { id: "included", label: "Included", value: planUsage.totalPercentUsed },
    { id: "api", label: "API", value: planUsage.apiPercentUsed },
    { id: "auto", label: "Auto", value: planUsage.autoPercentUsed },
  ];

  for (const spec of specs) {
    if (typeof spec.value !== "number") continue;
    windows.push(
      windowFromUsedPct({
        id: spec.id,
        label: spec.label,
        utilizationPct: spec.value,
        resetsAt,
        tone: toneFromUsedPct(spec.value),
      }),
    );
  }

  return windows;
}

function buildCursorDetails(
  planUsage: NonNullable<CursorUsageResponse["planUsage"]>,
  displayMessage: string | undefined,
): ProviderUsageDetail[] {
  const details: ProviderUsageDetail[] = [];
  const includedSpend = centsToDollars(planUsage.includedSpend ?? null);
  const bonusSpend = centsToDollars(planUsage.bonusSpend ?? null);

  if (includedSpend !== null) {
    details.push({
      id: "included_spend",
      label: "Included spend",
      value: `$${includedSpend.toFixed(2)}`,
    });
  }
  if (bonusSpend !== null && bonusSpend > 0) {
    details.push({
      id: "bonus_spend",
      label: "Bonus spend",
      value: `$${bonusSpend.toFixed(2)}`,
    });
  }
  if (displayMessage?.trim()) {
    details.push({
      id: "display_message",
      label: "Status",
      value: displayMessage.trim(),
    });
  }

  return details;
}

export class CursorQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "cursor";
  readonly displayName = "Cursor";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly homeDir: string | undefined;

  constructor(options: CursorQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
    this.homeDir = options.homeDir;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const envToken = process.env["CURSOR_ACCESS_TOKEN"] || process.env["CURSOR_TOKEN"] || null;
    const sqliteAuth = envToken
      ? { accessToken: envToken, planLabel: null }
      : await readCursorAuthFromSqlite(this.homeDir ?? homedir());

    if (!sqliteAuth.accessToken) return unavailableUsage(this);

    const res = await fetchProviderApi(
      this.fetchApi,
      "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sqliteAuth.accessToken}`,
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
    let windows: ProviderUsageWindow[] = [];
    let details: ProviderUsageDetail[] = [];

    if (resp.planUsage) {
      // Prefer included spend for the primary meter so bonus usage does not inflate
      // the bar past the plan limit (matches the Cursor dashboard included bucket).
      const includedSpend = centsToDollars(resp.planUsage.includedSpend ?? null);
      const totalSpend = centsToDollars(resp.planUsage.totalSpend ?? null);
      const used = includedSpend ?? totalSpend;
      const limit = centsToDollars(resp.planUsage.limit ?? null);
      const remainingFromApi = centsToDollars(resp.planUsage.remaining ?? null);
      // When we meter included spend, derive remaining from that pair so bonus spend
      // cannot leave the bar in a contradictory state. Fall back to the API remaining
      // only when included spend is absent (legacy total-spend responses).
      const remaining =
        includedSpend !== null && limit !== null
          ? Math.max(0, limit - includedSpend)
          : (remainingFromApi ??
            (used !== null && limit !== null ? Math.max(0, limit - used) : null));

      balances.push({
        id: "plan_usage",
        label: "Plan usage",
        used,
        remaining,
        limit,
        unit: "usd",
        resetsAt: billingCycleEnd,
        tone: toneFromUsedPct(usedPctOf(used, limit)),
      });

      windows = buildCursorWindows(resp.planUsage, billingCycleEnd);
      details = buildCursorDetails(resp.planUsage, resp.displayMessage);
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: sqliteAuth.planLabel,
      windows,
      balances,
      details,
      error: null,
    };
  }
}
