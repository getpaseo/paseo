// Adapted from kiawin/paseo-openrouter-usage. See LICENSE.
import {
  balanceToneFromRemaining,
  unavailable,
  type UsageAccount,
  type UsageReport,
  type UsageScope,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";

const meters = {
  key: { env: "OPENROUTER_API_KEY", label: "API key spend" },
  credits: { env: "OPENROUTER_MANAGEMENT_KEY", label: "Account credits" },
} as const;

export const inputSchema = z.strictObject({ meter: z.enum(["key", "credits"]) });

const keyResponse = z.object({
  data: z.object({
    usage_daily: z.number(),
    usage_weekly: z.number(),
    usage_monthly: z.number(),
  }),
});

const creditsResponse = z.object({
  data: z.object({ total_credits: z.number(), total_usage: z.number() }),
});

export async function discover(
  scope: UsageScope,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UsageAccount[]> {
  if (scope.kind !== "global") return [];
  return inputSchema.shape.meter.options.flatMap((meter) => {
    const { env: variable, label } = meters[meter];
    return env[variable]?.trim() ? [{ key: meter, label, input: { meter } }] : [];
  });
}

export async function fetchUsage(
  value: unknown,
  fetchApi: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UsageReport> {
  const { meter } = inputSchema.parse(value);
  const variable = meters[meter].env;
  const token = env[variable]?.trim();
  if (!token) throw new Error(`OpenRouter usage requires ${variable}`);

  const response = await fetchApi(`https://openrouter.ai/api/v1/${meter}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) {
    return unavailable({ kind: "rejected", status: response.status });
  }
  if (!response.ok) throw new Error(`OpenRouter usage API returned ${response.status}`);

  const body: unknown = await response.json();
  return meter === "key"
    ? keyReport(keyResponse.parse(body).data)
    : creditsReport(creditsResponse.parse(body).data);
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});

function keyReport(key: z.infer<typeof keyResponse>["data"]): UsageReport {
  return {
    status: "available",
    windows: [],
    details: [
      { id: "spend_daily", label: "Spent today (UTC)", value: usd.format(key.usage_daily) },
      { id: "spend_weekly", label: "Spent this week (UTC)", value: usd.format(key.usage_weekly) },
      {
        id: "spend_monthly",
        label: "Spent this month (UTC)",
        value: usd.format(key.usage_monthly),
      },
    ],
  };
}

function creditsReport(credits: z.infer<typeof creditsResponse>["data"]): UsageReport {
  const remaining = credits.total_credits - credits.total_usage;
  return {
    status: "available",
    windows: [],
    balances: [
      {
        id: "credits",
        label: "Credits",
        remaining,
        unit: "usd",
        tone: balanceToneFromRemaining(remaining),
      },
    ],
  };
}
