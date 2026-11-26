import type { UsageInput } from "../shared/input.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  toneFromUsedPct,
  usedPctOf,
  unavailable,
  windowFromUsedPct,
  type UsageAccount,
  type UsageReport,
  type UsageBalance,
  type UsageScope,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";

const ApiNumberSchema = z.coerce.number().finite();
const ApiNullableNumberSchema = z.preprocess(
  (value) => (value == null ? null : value),
  ApiNumberSchema.nullable(),
);
function toIsoStringOrNull(timestampMs: number): string | null {
  const date = new Date(timestampMs);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Cursor desktop stores auth in VS Code's ItemTable (state.vscdb). Modern builds keep
// the access token as a plain JWT string under `cursorAuth/accessToken`; older builds
// kept a JSON blob under `cursorAuthStatus`. Read it with node:sqlite so we don't
// depend on a `sqlite3` CLI, which isn't installed by default on Windows (or on many
// Linux hosts) — a missing binary silently rendered Cursor usage unavailable.
// Headless hosts (VPS, cursor-agent only) have no desktop db; their session lives in
// ~/.config/cursor/auth.json instead.
const CURSOR_ACCESS_TOKEN_KEY = "cursorAuth/accessToken";
const CURSOR_LEGACY_AUTH_KEY = "cursorAuthStatus";
const CURSOR_API_ORIGIN = "https://api2.cursor.sh";

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

const CursorUsageResponseSchema = z.object({
  planUsage: z
    .object({
      totalSpend: ApiNullableNumberSchema,
      includedSpend: ApiNullableNumberSchema,
      bonusSpend: ApiNullableNumberSchema,
      remaining: ApiNullableNumberSchema,
      limit: ApiNullableNumberSchema,
      totalPercentUsed: ApiNullableNumberSchema,
      autoPercentUsed: ApiNullableNumberSchema,
      apiPercentUsed: ApiNullableNumberSchema,
    })
    .nullish(),
  billingCycleStart: CursorBillingCycleTimestampSchema,
  billingCycleEnd: CursorBillingCycleTimestampSchema,
});

const CursorAuthStatusSchema = z.object({
  accessToken: z.string().optional(),
});

const CursorSdkLoginSchema = z.object({
  version: z.literal(1),
  backendUrl: z.literal(CURSOR_API_ORIGIN),
  apiKey: z.string().trim().min(1),
  apiKeyExpiresAtMs: z.number().finite().optional(),
});
const CursorApiKeyExchangeSchema = z.object({ accessToken: z.string().trim().min(1) });

type CursorUsageResponse = z.infer<typeof CursorUsageResponseSchema>;

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

async function readCursorTokenFromSqlite(path: string): Promise<string | null> {
  // Held in a variable so TypeScript skips module resolution: @types/node@20 has no
  // node:sqlite typings yet, while the runtime (Node 22+ / Electron) provides it.
  const sqliteSpecifier: string = "node:sqlite";
  let sqlite: NodeSqliteModule;
  try {
    sqlite = (await import(sqliteSpecifier)) as unknown as NodeSqliteModule;
  } catch {
    return null; // runtime without node:sqlite
  }

  if (!existsSync(path)) return null;
  let db: CursorStateDatabase | undefined;
  try {
    db = new sqlite.DatabaseSync(path, { readOnly: true });
    return cursorTokenFromDb(db);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

async function readCursorTokenFromAuthJson(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  try {
    const parsed = CursorAuthStatusSchema.parse(JSON.parse(await readFile(path, "utf8")));
    return parsed.accessToken?.trim() || null;
  } catch {
    return null;
  }
}

async function readSdkLogin(path: string) {
  if (!existsSync(path)) return undefined;
  try {
    return CursorSdkLoginSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

async function resolveUsageToken(
  input: UsageInput,
  fetchApi: typeof fetch,
  signal: AbortSignal,
): Promise<string | ReturnType<typeof unavailable>> {
  if (input.store !== "sdk") {
    const token = await readCredential(input);
    if (!token) throw new Error("Cursor login store no longer exists");
    return token;
  }

  const sdkLogin = await readSdkLogin(input.locator);
  if (!sdkLogin) throw new Error("Cursor SDK login store no longer exists");
  const expiresAt = sdkLogin.apiKeyExpiresAtMs;
  if (expiresAt !== undefined && expiresAt <= Date.now()) {
    const isoExpiry = toIsoStringOrNull(expiresAt);
    if (isoExpiry) return unavailable({ kind: "expired", expiresAt: isoExpiry });
  }
  const exchange = await fetchApi(`${CURSOR_API_ORIGIN}/auth/exchange_user_api_key`, {
    signal,
    method: "POST",
    redirect: "error",
    headers: { Authorization: `Bearer ${sdkLogin.apiKey}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (exchange.status === 401 || exchange.status === 403)
    return unavailable({ kind: "rejected", status: exchange.status });
  if (!exchange.ok) throw new Error(`Cursor API key exchange returned ${exchange.status}`);
  const result = CursorApiKeyExchangeSchema.safeParse(await exchange.json().catch(() => null));
  if (!result.success) throw new Error("Cursor API key exchange returned no access token");
  return result.data.accessToken;
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  const signal = AbortSignal.timeout(15_000);
  const token = await resolveUsageToken(input, fetchApi, signal);
  if (typeof token !== "string") return token;

  const res = await fetchApi(
    `${CURSOR_API_ORIGIN}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`,
    {
      signal,
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "X-Cursor-Client-Type": "cli",
      },
      body: JSON.stringify({}),
    },
  );

  if (res.status === 401 || res.status === 403)
    return unavailable({ kind: "rejected", status: res.status });
  if (!res.ok) throw new Error(`Cursor usage API returned ${res.status}`);

  const resp = CursorUsageResponseSchema.parse(await res.json());
  const billingCycleEnd = parseCursorBillingCycleTimestamp(resp.billingCycleEnd);
  const windows: UsageWindow[] = [];
  const balances: UsageBalance[] = [];
  if (resp.planUsage) {
    // Total spend includes bonus credits; returned percentages measure quota usage.
    for (const [id, label, usedPct] of [
      ["plan_usage", "Total", resp.planUsage.totalPercentUsed],
      ["cursor_usage", "Cursor", resp.planUsage.autoPercentUsed],
      ["third_party_usage", "Third Party", resp.planUsage.apiPercentUsed],
    ] as const) {
      if (usedPct === null) continue;
      windows.push(
        windowFromUsedPct({
          id,
          label,
          utilizationPct: usedPct,
          resetsAt: billingCycleEnd,
          summary: id === "plan_usage",
          tone: toneFromUsedPct(usedPct),
        }),
      );
    }
  }
  if (resp.planUsage && windows.length === 0) {
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
      tone: toneFromUsedPct(usedPctOf(totalSpend, limit)),
    });
  }

  return {
    status: "available",
    planLabel: undefined,
    windows,
    balances,
    details: [],
  };
}

async function readCredential(input: UsageInput): Promise<string | undefined> {
  if (input.store === "env") return process.env[input.locator];
  if (input.store === "sdk") return (await readSdkLogin(input.locator))?.apiKey;
  const token =
    input.store === "sqlite"
      ? await readCursorTokenFromSqlite(input.locator)
      : await readCursorTokenFromAuthJson(input.locator);
  return token ?? undefined;
}

const CursorIdentitySchema = z.object({ sub: z.string().min(1) });

function cursorAccount(input: UsageInput, token?: string): UsageAccount {
  const parts = token?.split(".");
  if (parts?.length === 3) {
    try {
      const payload: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
      const identity = CursorIdentitySchema.safeParse(payload);
      if (identity.success) {
        const key = createHash("sha256").update(identity.data.sub).digest("hex");
        return { key: `account-${key}`, input };
      }
    } catch {
      // Non-JWT logins still have a usage card, isolated to their credential store.
    }
  }
  const key = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return { key: `store-${key}`, input };
}

export async function discover(): Promise<UsageAccount[]> {
  const home = homedir();
  const candidates: UsageInput[] = ["CURSOR_ACCESS_TOKEN", "CURSOR_TOKEN"].map((locator) => ({
    store: "env",
    locator,
  }));
  candidates.push({ store: "sdk", locator: join(home, ".cursor", "sdk", "paseo-usage.json") });
  if (process.env.APPDATA)
    candidates.push({
      store: "sqlite",
      locator: join(process.env.APPDATA, "Cursor", "User", "globalStorage", "state.vscdb"),
    });
  candidates.push(
    ...[
      join(
        home,
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      ),
      join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
    ].map((locator) => ({ store: "sqlite" as const, locator })),
    { store: "file", locator: join(home, ".config", "cursor", "auth.json") },
  );
  for (const input of candidates) {
    const credential = await readCredential(input);
    if (credential) return [cursorAccount(input, input.store === "sdk" ? undefined : credential)];
  }
  return [];
}

// Account identity joins global and session logins without merging different users.
export async function discoverSession(
  scope: Extract<UsageScope, { kind: "session" }>,
  platform: NodeJS.Platform = process.platform,
): Promise<UsageAccount[]> {
  if (scope.provider !== "cursor") return [];
  const locator = cursorAgentAuthPath(scope.env, platform);
  if (!locator) return [];
  const input: UsageInput = { store: "file", locator };
  const token = await readCredential(input);
  return token ? [cursorAccount(input, token)] : [];
}

// Mirrors cursor-agent's credential store. Env credentials win over the stored login and
// can't be named by an input. AGENT_CLI_CREDENTIAL_STORE picks "file" or "memory"; by
// default macOS keeps the login in the Keychain and other platforms in auth.json.
function cursorAgentAuthPath(env: Record<string, string>, platform: NodeJS.Platform) {
  if (env.CURSOR_API_KEY || env.CURSOR_AUTH_TOKEN) return null;
  const store = env.AGENT_CLI_CREDENTIAL_STORE;
  if (store === "memory" || (platform === "darwin" && store !== "file")) return null;
  const home = env.HOME || env.USERPROFILE || homedir();
  if (platform === "win32")
    return join(env.APPDATA || join(home, "AppData", "Roaming"), "Cursor", "auth.json");
  if (platform === "darwin") return join(home, ".cursor", "auth.json");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "cursor", "auth.json");
}
