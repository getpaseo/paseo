import { z } from "zod";
import {
  balanceToneFromRemaining,
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  usedPctOf,
  windowFromUsedPct,
  type UsageAccount,
  type UsageReport,
} from "@getpaseo/plugin/server/usage";
import type { UsageInput } from "../shared/input.js";
import { readSigninKey, signinKeyPath, signRequest } from "./signin.js";

const CLOUD_HOST = "https://ollama.com";

const meResponseSchema = z.object({ plan: z.string().optional(), Plan: z.string().optional() });

const includedBalanceSchema = z.object({
  balance_usd: z.number(),
  allowance_usd: z.number(),
  period: z.object({
    from: z.string(),
    until: z.string(),
  }),
});

const legacyLimitSchema = z.object({
  remaining_percent: z.number(),
  resets_at: z.string(),
});

const balanceResponseSchema = z.object({
  included: z.union([
    includedBalanceSchema,
    z.object({
      session: legacyLimitSchema,
      weekly: legacyLimitSchema,
    }),
  ]),
  purchased: z.object({
    balance_usd: z.number(),
  }),
});

type Env = Readonly<Record<string, string | undefined>>;

/** Builds a request to ollama.com authorized the way the chosen login store allows. */
type Authorize = (
  method: "GET" | "POST",
  pathname: string,
) => { url: string; headers: HeadersInit };

async function authorizer(input: UsageInput, env: Env): Promise<Authorize | undefined> {
  if (input.source === "signin") {
    const key = await readSigninKey(input.keyPath);
    if (!key) return undefined;
    return (method, pathname) => {
      const signed = signRequest(key, method, pathname);
      return {
        url: `${CLOUD_HOST}${pathname}?${signed.query}`,
        headers: { Authorization: signed.authorization, Accept: "application/json" },
      };
    };
  }
  const apiKey = env[input.locator]?.trim();
  if (!apiKey) return undefined;
  return (_method, pathname) => ({
    url: `${CLOUD_HOST}${pathname}`,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
}

async function readPlan(authorize: Authorize, fetchApi: typeof fetch): Promise<string | undefined> {
  try {
    const request = authorize("POST", "/api/me");
    const res = await fetchApi(request.url, {
      method: "POST",
      headers: request.headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const me = meResponseSchema.parse(await res.json());
    const plan = me.plan ?? me.Plan;
    return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : undefined;
  } catch {
    return undefined;
  }
}

function usedFromRemaining(remainingPct: number): number {
  return Math.round((100 - remainingPct) * 100) / 100;
}

function reportFromBalance(body: z.infer<typeof balanceResponseSchema>): UsageReport {
  const purchased = body.purchased.balance_usd;
  // Most plans never buy credits; an empty purchased balance is not a warning.
  const balances =
    purchased > 0
      ? [
          {
            id: "purchased",
            label: "Purchased credits",
            remaining: purchased,
            unit: "usd" as const,
            tone: balanceToneFromRemaining(purchased),
          },
        ]
      : [];

  if ("balance_usd" in body.included) {
    const { balance_usd, allowance_usd, period } = body.included;
    const used = allowance_usd - balance_usd;
    return {
      status: "available",
      windows: [
        windowFromUsedPct({
          id: "included",
          label: "Included",
          summary: true,
          utilizationPct: usedPctOf(used, allowance_usd),
          resetsAt: period.until,
          tone: toneFromUsedPct(usedPctOf(used, allowance_usd)),
        }),
      ],
      balances: [
        {
          id: "included",
          label: "Included credits",
          used,
          remaining: balance_usd,
          limit: allowance_usd,
          unit: "usd",
          resetsAt: period.until,
          tone: balanceToneFromRemaining(balance_usd),
        },
        ...balances,
      ],
      details: [
        { id: "period_from", label: "Period from", value: period.from },
        { id: "period_until", label: "Period until", value: period.until },
      ],
    };
  }

  const sessionUsed = usedFromRemaining(body.included.session.remaining_percent);
  const weeklyUsed = usedFromRemaining(body.included.weekly.remaining_percent);
  return {
    status: "available",
    windows: [
      windowFromUsedPct({
        id: "session",
        label: "Session",
        summary: true,
        utilizationPct: sessionUsed,
        resetsAt: body.included.session.resets_at,
        tone: toneFromUsedPct(sessionUsed),
      }),
      windowFromUsedPct({
        id: "weekly",
        label: "Weekly",
        shortLabel: "wk",
        summary: true,
        utilizationPct: weeklyUsed,
        resetsAt: body.included.weekly.resets_at,
        tone: toneFromUsedPct(weeklyUsed),
      }),
    ],
    balances,
  };
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
  env: Env = process.env,
): Promise<UsageReport> {
  const authorize = await authorizer(input, env);
  if (!authorize) throw new Error("Ollama login no longer exists");

  const request = authorize("GET", "/api/balance");
  const res = await fetchApi(request.url, {
    signal: AbortSignal.timeout(15_000),
    headers: request.headers,
  });

  if (res.status === 401 || res.status === 403)
    return unavailable({ kind: "rejected", status: res.status });
  if (res.status === 429) return unavailable({ kind: "no_quota", detail: "Rate limited" });
  if (!res.ok) throw new Error(`Ollama balance API returned ${res.status}`);

  const report = reportFromBalance(balanceResponseSchema.parse(await res.json()));
  if (report.status !== "available") return report;
  const planLabel = await readPlan(authorize, fetchApi);
  return planLabel ? { ...report, planLabel } : report;
}

/** One account per host: the `ollama signin` key, then OLLAMA_API_KEY. */
export async function discover(env: Env = process.env): Promise<UsageAccount[]> {
  const keyPath = signinKeyPath(env.HOME || env.USERPROFILE || undefined);
  const signin = await readSigninKey(keyPath).catch(() => undefined);
  if (signin)
    return [
      {
        key: hashAccountKey(`signin:${signin.publicKey}`),
        harness: "Ollama",
        input: { source: "signin", keyPath },
      },
    ];

  const envKey = env.OLLAMA_API_KEY?.trim();
  if (envKey)
    return [
      {
        key: hashAccountKey(`key:${envKey}`),
        input: { source: "env", locator: "OLLAMA_API_KEY" },
      },
    ];
  return [];
}
