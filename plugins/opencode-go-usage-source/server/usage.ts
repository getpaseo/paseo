import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  usedPctOf,
  type UsageAccount,
  windowFromUsedPct,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import type { Input } from "../shared/input.js";
import { consoleDatabasePath, fetchConsoleGoStatus, readConsoleLogin } from "./console.js";

const authSchema = z
  .object({
    "opencode-go": z
      .object({ type: z.literal("api"), key: z.string().min(1) })
      .passthrough()
      .optional(),
  })
  .passthrough();
const windowSchema = z.object({
  status: z.enum(["ok", "rate-limited"]),
  percent: z.number().finite(),
  resetsAt: z.iso.datetime(),
});
const responseSchema = z.object({
  usage: z.object({ rolling: windowSchema, weekly: windowSchema, monthly: windowSchema }),
});

// The Console API reports three named periods: fiveHour, week, and month. The
// five-hour field is a reported duration, so it uses the SDK's name for 18000 seconds.
const consoleWindows = [
  { field: "fiveHour", id: "five_hour", label: "5-hour", shortLabel: "5h" },
  { field: "week", id: "weekly", label: "Weekly", shortLabel: "wk" },
  { field: "month", id: "monthly", label: "Monthly", shortLabel: "mo" },
] as const;

function authPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(
    env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"),
    "opencode",
    "auth.json",
  );
}

export async function readDefaultKey(path = authPath()): Promise<string | null> {
  try {
    const auth = authSchema.parse(JSON.parse(await readFile(path, "utf8")));
    return auth["opencode-go"]?.key ?? null;
  } catch {
    return null;
  }
}

export async function discover(
  path = authPath(),
  databasePath = consoleDatabasePath(),
): Promise<UsageAccount[]> {
  const accounts: UsageAccount[] = [];
  // The Console OAuth login is the current store; auth.json is the legacy API key.
  const login = await readConsoleLogin(databasePath);
  if (login)
    accounts.push({
      key: login.accountID ?? hashAccountKey(databasePath),
      label: login.email ?? login.orgName ?? undefined,
      harness: "OpenCode",
      input: { store: "console", path: databasePath },
    });
  if (await readDefaultKey(path))
    accounts.push({
      key: hashAccountKey(path),
      harness: "OpenCode",
      input: { store: "api-key", path },
    });
  return accounts;
}

export async function fetchUsage(
  input: Input,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  if (input.store === "api-key") return fetchApiKeyUsage(input.path, fetchApi);
  return fetchConsoleUsage(input.path, fetchApi);
}

async function fetchApiKeyUsage(path: string, fetchApi: typeof fetch): Promise<UsageReport> {
  const apiKey = await readDefaultKey(path);
  if (!apiKey) throw new Error("OpenCode Go login store no longer exists");
  const response = await fetchApi("https://opencode.ai/zen/go/v1/usage", {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403)
    return unavailable({ kind: "rejected", status: response.status, refreshedBy: "opencode" });
  if (!response.ok) throw new Error(`OpenCode Go usage API returned ${response.status}`);
  const data = responseSchema.parse(await response.json());
  const windows = (
    [
      // The rolling window's length is not reported, so its percent stands without a name.
      ["rolling", "Rolling", "", data.usage.rolling],
      ["weekly", "Weekly", "wk", data.usage.weekly],
      ["monthly", "Monthly", "mo", data.usage.monthly],
    ] as const
  ).map(([id, label, shortLabel, value]) =>
    windowFromUsedPct({
      id,
      label,
      shortLabel,
      utilizationPct: value.percent,
      resetsAt: value.resetsAt,
      tone: toneFromUsedPct(value.percent),
    }),
  );
  return { status: "available", planLabel: "Go", windows };
}

async function fetchConsoleUsage(path: string, fetchApi: typeof fetch): Promise<UsageReport> {
  const login = await readConsoleLogin(path);
  if (!login) throw new Error("OpenCode Go login store no longer exists");
  if (login.expires !== null && login.expires <= Date.now())
    return unavailable({
      kind: "expired",
      expiresAt: new Date(login.expires).toISOString(),
      refreshedBy: "opencode",
    });
  const result = await fetchConsoleGoStatus(login.access, fetchApi);
  if (result.kind === "rejected")
    return unavailable({ kind: "rejected", status: result.httpStatus, refreshedBy: "opencode" });
  const meters = result.status.access?.meters;
  if (!meters)
    return unavailable({
      kind: "no_quota",
      detail: "This account has no active OpenCode Go subscription.",
    });
  const windows: UsageWindow[] = [];
  for (const spec of consoleWindows) {
    const meter = meters[spec.field];
    if (!meter) continue;
    const usedPct = usedPctOf(Number(meter.usedMicroCents), Number(meter.limitMicroCents));
    if (usedPct === null) continue;
    windows.push(
      windowFromUsedPct({
        id: spec.id,
        label: spec.label,
        shortLabel: spec.shortLabel,
        utilizationPct: usedPct,
        resetsAt: toIso(meter.resetsAt),
        tone: toneFromUsedPct(usedPct),
      }),
    );
  }
  if (windows.length === 0)
    return unavailable({
      kind: "no_quota",
      detail: "OpenCode Go did not report any usage windows for this account.",
    });
  return {
    status: "available",
    planLabel: result.status.product === "go-plus" ? "Go Plus" : "Go",
    windows,
  };
}

function toIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
