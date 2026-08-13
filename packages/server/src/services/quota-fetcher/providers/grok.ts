import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageWindow,
} from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNumberSchema,
  ApiOptionalStringSchema,
  toneFromUsedPct,
  usedPctOf,
  fetchProviderApi,
  unavailableUsage,
  windowFromUsedPct,
} from "../usage.js";

const GrokWrappedNumberSchema = z
  .object({
    val: ApiNumberSchema.optional(),
  })
  .nullish();

const GrokPeriodSchema = z
  .object({
    type: ApiOptionalStringSchema,
    start: ApiOptionalStringSchema,
    end: ApiOptionalStringSchema,
  })
  .nullish();

const GrokUsageResponseSchema = z.object({
  config: z
    .object({
      monthlyLimit: GrokWrappedNumberSchema,
      weeklyLimit: GrokWrappedNumberSchema,
      used: GrokWrappedNumberSchema,
      weeklyUsed: GrokWrappedNumberSchema,
      creditUsagePercent: ApiNumberSchema.optional(),
      currentPeriod: GrokPeriodSchema,
      prepaidBalance: GrokWrappedNumberSchema,
      billingPeriodStart: ApiOptionalStringSchema,
      billingPeriodEnd: ApiOptionalStringSchema,
    })
    .nullish(),
  usage: z
    .object({
      creditUsage: ApiNumberSchema.optional(),
      weeklyUsage: ApiNumberSchema.optional(),
    })
    .nullish(),
});

// Grok CLI `/usage` reads this query. Plain `/v1/billing` returns monthly
// credits only and hides the weekly SuperGrok pool.
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";

const GrokSettingsResponseSchema = z.object({
  subscription_tier_display: ApiOptionalStringSchema,
});

interface GrokQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  /** Override home directory (tests). Production uses os.homedir(). */
  homeDir?: string;
}

async function readJsonBodyOrNull(response: Response): Promise<unknown | null> {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function readGrokPlanLabel(
  settingsResult: PromiseSettledResult<Response>,
): Promise<string | null> {
  if (settingsResult.status !== "fulfilled" || !settingsResult.value.ok) {
    return null;
  }
  const parsed = GrokSettingsResponseSchema.safeParse(
    await readJsonBodyOrNull(settingsResult.value),
  );
  const label = parsed.success ? parsed.data.subscription_tier_display : undefined;
  return label && label.length > 0 ? label : null;
}

function wrappedNumber(value: { val?: number } | null | undefined): number | null {
  return value?.val ?? null;
}

function grokLimitWindow(input: {
  id: string;
  label: string;
  used: number | null;
  limit: number | null;
  usedPct?: number | null;
  resetsAt: string | null;
}): ProviderUsageWindow | null {
  const usedPct = input.usedPct ?? usedPctOf(input.used, input.limit);
  if (usedPct === null) return null;
  return windowFromUsedPct({
    id: input.id,
    label: input.label,
    utilizationPct: usedPct,
    resetsAt: input.resetsAt,
    tone: toneFromUsedPct(usedPct),
  });
}

function grokPeriodWindow(
  percent: number | null | undefined,
  periodType: string | undefined,
  resetsAt: string | null,
): ProviderUsageWindow | null {
  if (typeof percent !== "number") return null;
  const weekly = (periodType ?? "").toUpperCase().includes("WEEKLY");
  return grokLimitWindow({
    id: weekly ? "weekly" : "monthly",
    label: weekly ? "Weekly" : "Monthly",
    used: null,
    limit: null,
    usedPct: percent,
    resetsAt,
  });
}

function mergeGrokWindows(
  periodWindow: ProviderUsageWindow | null,
  countedWindows: ProviderUsageWindow[],
): ProviderUsageWindow[] {
  if (periodWindow && !countedWindows.some((window) => window.id === periodWindow.id)) {
    return [periodWindow, ...countedWindows];
  }
  return countedWindows;
}

function grokPrepaidBalance(prepaid: number | null): ProviderUsageBalance | null {
  if (prepaid === null || prepaid <= 0) return null;
  return {
    id: "credits",
    label: "Credits",
    remaining: prepaid,
    unit: "credits",
    tone: "ok",
  };
}

interface GrokBillingAmounts {
  monthlyLimit: number | null;
  creditUsage: number | null;
  weeklyLimit: number | null;
  weeklyUsed: number | null;
  periodResetsAt: string | null;
  usagePercent: number | undefined;
  periodType: string | undefined;
  prepaid: number | null;
}

function readGrokBillingAmounts(resp: z.infer<typeof GrokUsageResponseSchema>): GrokBillingAmounts {
  const config = resp.config;
  return {
    monthlyLimit: wrappedNumber(config?.monthlyLimit),
    // Live CLI billing uses config.used.val; older mocks used usage.creditUsage.
    creditUsage: wrappedNumber(config?.used) ?? resp.usage?.creditUsage ?? null,
    weeklyLimit: wrappedNumber(config?.weeklyLimit),
    weeklyUsed: wrappedNumber(config?.weeklyUsed) ?? resp.usage?.weeklyUsage ?? null,
    periodResetsAt: config?.currentPeriod?.end ?? config?.billingPeriodEnd ?? null,
    usagePercent: config?.creditUsagePercent,
    periodType: config?.currentPeriod?.type,
    prepaid: wrappedNumber(config?.prepaidBalance),
  };
}

interface GrokUsageBars {
  windows: ProviderUsageWindow[];
  balances: ProviderUsageBalance[];
}

function grokWindowsFromBilling(resp: z.infer<typeof GrokUsageResponseSchema>): GrokUsageBars {
  const amounts = readGrokBillingAmounts(resp);
  const windows = mergeGrokWindows(
    grokPeriodWindow(amounts.usagePercent, amounts.periodType, amounts.periodResetsAt),
    [
      grokLimitWindow({
        id: "monthly",
        label: "Monthly",
        used: amounts.creditUsage,
        limit: amounts.monthlyLimit,
        resetsAt: amounts.periodResetsAt,
      }),
      grokLimitWindow({
        id: "weekly",
        label: "Weekly",
        used: amounts.weeklyUsed,
        limit: amounts.weeklyLimit,
        resetsAt: amounts.periodResetsAt,
      }),
    ].filter((window): window is ProviderUsageWindow => window !== null),
  );

  const creditBalance =
    grokCreditBalance({
      used: amounts.creditUsage,
      limit: amounts.monthlyLimit,
      resetsAt: amounts.periodResetsAt,
    }) ?? grokPrepaidBalance(amounts.prepaid);

  return { windows, balances: creditBalance ? [creditBalance] : [] };
}

function grokCreditBalance(input: {
  used: number | null;
  limit: number | null;
  resetsAt: string | null;
}): ProviderUsageBalance | null {
  const hasCreditQuota = (input.limit !== null && input.limit > 0) || (input.used ?? 0) > 0;
  if (!hasCreditQuota) return null;
  const remaining =
    input.limit !== null && input.used !== null ? Math.max(0, input.limit - input.used) : null;
  return {
    id: "credits",
    label: "Credits",
    used: input.used,
    remaining,
    limit: input.limit,
    unit: "credits",
    resetsAt: input.resetsAt,
    tone: toneFromUsedPct(usedPctOf(input.used, input.limit)),
  };
}

/** Resolve a Grok CLI token from ~/.grok/auth.json (legacy or current nested shape). */
export function extractGrokTokenFromAuth(auth: unknown): string | null {
  if (auth == null || typeof auth !== "object" || Array.isArray(auth)) return null;
  const record = auth as Record<string, unknown>;

  const topLevel = record["access_token"];
  if (typeof topLevel === "string" && topLevel.length > 0) {
    return topLevel;
  }

  const entries = Object.entries(record);
  const preferred = entries.filter(([key]) => key.startsWith("https://auth.x.ai::"));
  const candidates = preferred.length > 0 ? preferred : entries;

  for (const [, value] of candidates) {
    if (value == null || typeof value !== "object" || Array.isArray(value)) continue;
    const nestedKey = (value as Record<string, unknown>)["key"];
    if (typeof nestedKey === "string" && nestedKey.length > 0) {
      return nestedKey;
    }
  }

  return null;
}

export class GrokQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "grok";
  readonly displayName = "Grok";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly homeDir: string | undefined;

  constructor(options: GrokQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
    this.homeDir = options.homeDir;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const token =
      process.env["GROK_API_KEY"] || process.env["GROK_TOKEN"] || (await this.readGrokToken());

    if (!token) return unavailableUsage(this);

    const headers = {
      Authorization: `Bearer ${token}`,
      "X-XAI-Token-Auth": "xai-grok-cli",
      Accept: "application/json",
    };

    const [billingResult, settingsResult] = await Promise.allSettled([
      fetchProviderApi(this.fetchApi, GROK_BILLING_URL, { headers }),
      fetchProviderApi(this.fetchApi, GROK_SETTINGS_URL, { headers }),
    ]);

    if (billingResult.status === "rejected" || !billingResult.value.ok) {
      const status = billingResult.status === "fulfilled" ? billingResult.value.status : undefined;
      this.logger.debug({ status }, "Grok usage fetch failed");
      return unavailableUsage(this);
    }

    const { windows, balances } = grokWindowsFromBilling(
      GrokUsageResponseSchema.parse(await billingResult.value.json()),
    );

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: await readGrokPlanLabel(settingsResult),
      windows,
      balances,
      details: [],
      error: null,
    };
  }

  private async readGrokToken(): Promise<string | null> {
    // homeDir override is for tests: Windows os.homedir() ignores $HOME (uses USERPROFILE).
    const path = join(this.homeDir ?? homedir(), ".grok", "auth.json");
    if (!existsSync(path)) return null;
    try {
      return extractGrokTokenFromAuth(JSON.parse(await fs.readFile(path, "utf8")));
    } catch {
      return null;
    }
  }
}
