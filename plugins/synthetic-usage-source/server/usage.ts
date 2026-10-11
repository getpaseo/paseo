import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  type UsageAccount,
  type UsageReport,
  type UsageScope,
  usedPctOf,
  windowFromUsedPct,
} from "@getpaseo/plugin/server/usage";
import { inputSchema, type Input } from "../shared/input.js";

const quotasSchema = z.object({
  rollingFiveHourLimit: z
    .object({
      nextTickAt: z.iso.datetime({ offset: true }),
      remaining: z.number().finite().nonnegative(),
      max: z.number().finite().nonnegative(),
    })
    .nullish(),
  weeklyTokenLimit: z
    .object({
      percentRemaining: z.number().finite().min(0).max(100),
      nextRegenAt: z.iso.datetime({ offset: true }).nullish(),
    })
    .nullish(),
  subscription: z.object({
    limit: z.number().finite().nonnegative(),
    requests: z.number().finite().nonnegative(),
    renewsAt: z.iso.datetime({ offset: true }),
  }),
});
const openCodeKeySchema = z.object({ type: z.literal("key"), key: z.string().trim().min(1) });
const legacyAuthSchema = z.object({
  synthetic: z.object({ type: z.literal("api"), key: z.string().trim().min(1) }).optional(),
});

interface CredentialDatabase {
  prepare(sql: string): { get(...params: unknown[]): Record<string, unknown> | undefined };
  close(): void;
}
interface NodeSqliteModule {
  DatabaseSync: new (path: string, options: { readOnly: boolean }) => CredentialDatabase;
}

const environmentVariables = ["PASEO_SYNTHETIC_API_KEY", "SYNTHETIC_API_KEY"] as const;

function dataDirectory(input: Extract<Input, { store: "opencode" }>): string {
  return join(input.xdgDataHome || join(input.homeDir, ".local", "share"), "opencode");
}

function databasePath(input: Extract<Input, { store: "opencode" }>): string | null {
  const override = input.databaseOverride;
  if (override === ":memory:") return null;
  return resolve(dataDirectory(input), override || "opencode.db");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function credentialReadError(cause: unknown): Error {
  return new Error("Could not read Synthetic credentials from OpenCode", { cause });
}

function isCredentialDataError(error: unknown): boolean {
  if (error instanceof SyntaxError || error instanceof z.ZodError) return true;
  if (!(error instanceof Error) || !("code" in error)) return false;
  return typeof error.code === "string" && error.code.startsWith("ERR_SQLITE");
}

async function readOpenCodeKey(
  input: Extract<Input, { store: "opencode" }>,
): Promise<string | null> {
  const dbPath = databasePath(input);
  if (dbPath && (await fileExists(dbPath))) {
    try {
      const sqliteSpecifier: string = "node:sqlite";
      const sqlite: NodeSqliteModule = await import(sqliteSpecifier);
      const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      try {
        const hasCredentials = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credential'")
          .get();
        const row = hasCredentials
          ? db
              .prepare(
                "SELECT value FROM credential WHERE integration_id = ? ORDER BY active DESC, time_created DESC, id DESC LIMIT 1",
              )
              .get("synthetic")
          : undefined;
        if (row) {
          const value = z.string().parse(row.value);
          return openCodeKeySchema.parse(JSON.parse(value)).key;
        }
      } finally {
        db.close();
      }
    } catch (error) {
      if (!isCredentialDataError(error)) throw error;
      throw credentialReadError(error);
    }
  }

  const authPath = join(dataDirectory(input), "auth.json");
  if (!(await fileExists(authPath))) return null;
  try {
    const auth = legacyAuthSchema.parse(JSON.parse(await readFile(authPath, "utf8")));
    return auth.synthetic?.key ?? null;
  } catch (error) {
    if (!isCredentialDataError(error)) throw error;
    throw credentialReadError(error);
  }
}

function openCodeInput(env: NodeJS.ProcessEnv): Extract<Input, { store: "opencode" }> {
  const homeDir = env.HOME || env.USERPROFILE || homedir();
  const input: Extract<Input, { store: "opencode" }> = { store: "opencode", homeDir };
  if (env.XDG_DATA_HOME) input.xdgDataHome = env.XDG_DATA_HOME;
  if (env.OPENCODE_DB) input.databaseOverride = env.OPENCODE_DB;
  return input;
}

function environmentInput(): Extract<Input, { store: "environment" }> | null {
  for (const variable of environmentVariables) {
    if (process.env[variable]?.trim()) return { store: "environment", variable };
  }
  return null;
}

function account(input: Input, harness: string): UsageAccount {
  return { key: hashAccountKey(JSON.stringify(input)), harness, input };
}

export async function discover(scope: UsageScope): Promise<UsageAccount[]> {
  if (scope.kind === "session" && !scope.model?.toLowerCase().startsWith("synthetic/")) return [];
  const envInput = environmentInput();
  if (envInput) return [account(envInput, "Synthetic")];

  const lookupEnv = scope.kind === "session" ? { ...process.env, ...scope.env } : process.env;
  const input = openCodeInput(lookupEnv);
  try {
    if (!(await readOpenCodeKey(input))) return [];
  } catch {
    const dbPath = databasePath(input);
    const authPath = join(dataDirectory(input), "auth.json");
    if (
      !(await Promise.all([dbPath ? fileExists(dbPath) : false, fileExists(authPath)])).some(
        Boolean,
      )
    )
      throw new Error("Could not locate Synthetic credentials in OpenCode");
  }
  return [account(input, "OpenCode")];
}

interface QuotaFetchResult {
  ok: true;
  quotas: z.infer<typeof quotasSchema>;
}

interface QuotaFetchFailure {
  ok: false;
  report: UsageReport;
}

async function fetchQuotas(
  key: string,
  input: Input,
  fetchApi: typeof fetch,
): Promise<QuotaFetchResult | QuotaFetchFailure> {
  let response: Response;
  try {
    response = await fetchApi("https://api.synthetic.new/v2/quotas", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return {
      ok: false,
      report: { status: "error", error: error instanceof Error ? error.message : String(error) },
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      report: unavailable({
        kind: "rejected",
        status: response.status,
        ...(input.store === "opencode" ? { refreshedBy: "OpenCode" } : {}),
      }),
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      report: {
        status: "error",
        error: `Synthetic usage request failed (HTTP ${response.status})`,
      },
    };
  }
  try {
    return { ok: true, quotas: quotasSchema.parse(await response.json()) };
  } catch {
    return {
      ok: false,
      report: { status: "error", error: "Synthetic returned an invalid quota response" },
    };
  }
}

function reportFromQuotas(quotas: z.infer<typeof quotasSchema>): UsageReport {
  const rolling = quotas.rollingFiveHourLimit;
  const requests = rolling
    ? Math.round(Math.max(0, rolling.max - rolling.remaining) * 100) / 100
    : quotas.subscription.requests;
  const limit = rolling?.max ?? quotas.subscription.limit;
  const usedPct = usedPctOf(requests, limit);
  let fiveHourReset: string | null = null;
  if (requests > 0) fiveHourReset = rolling?.nextTickAt ?? quotas.subscription.renewsAt;
  const windows = [
    windowFromUsedPct({
      id: "five_hour",
      label: "5 hours",
      utilizationPct: usedPct,
      resetsAt: fiveHourReset,
      tone: toneFromUsedPct(usedPct),
      summary: true,
    }),
  ];
  if (quotas.weeklyTokenLimit) {
    const weeklyUsedPct = 100 - quotas.weeklyTokenLimit.percentRemaining;
    const resetsAt = weeklyUsedPct > 0 ? (quotas.weeklyTokenLimit.nextRegenAt ?? null) : null;
    windows.push(
      windowFromUsedPct({
        id: "weekly",
        label: "Weekly",
        utilizationPct: weeklyUsedPct,
        resetsAt,
        tone: toneFromUsedPct(weeklyUsedPct),
      }),
    );
  }
  return {
    status: "available",
    windows,
    details: [{ id: "requests", label: "Requests", value: `${requests} / ${limit}` }],
  };
}

async function resolveKey(input: Input): Promise<string | null> {
  if (input.store === "environment") {
    const key = process.env[input.variable]?.trim();
    if (!key) throw new Error("Synthetic API key is no longer available in the daemon environment");
    return key;
  }
  return readOpenCodeKey(input);
}

export async function fetchUsage(
  rawInput: unknown,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  const input = inputSchema.parse(rawInput);
  let key: string | null;
  try {
    key = await resolveKey(input);
  } catch (error) {
    return { status: "error", error: error instanceof Error ? error.message : String(error) };
  }
  if (!key)
    return unavailable({ kind: "no_quota", detail: "Synthetic credentials are unavailable" });
  const result = await fetchQuotas(key, input, fetchApi);
  return result.ok ? reportFromQuotas(result.quotas) : result.report;
}
