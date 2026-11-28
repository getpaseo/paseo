import { homedir } from "node:os";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  usedPctOf,
  type UsageAccount,
  type UsageDetail,
  type UsageReport,
  type UsageScope,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import { kiroDatabasePath, readKiroLogin, type KiroLogin, type StoreLookup } from "./store.js";

export const inputSchema = z.strictObject({ path: z.string().min(1) });
export type KiroUsageInput = z.infer<typeof inputSchema>;

const number = z.number().finite();
const breakdownSchema = z.object({
  resourceType: z.string().nullish(),
  displayName: z.string().nullish(),
  displayNamePlural: z.string().nullish(),
  currentUsage: number.nullish(),
  currentUsageWithPrecision: number.nullish(),
  usageLimit: number.nullish(),
  usageLimitWithPrecision: number.nullish(),
  nextDateReset: number.nullish(),
  freeTrialInfo: z
    .object({
      currentUsage: number.nullish(),
      currentUsageWithPrecision: number.nullish(),
      usageLimit: number.nullish(),
      usageLimitWithPrecision: number.nullish(),
      freeTrialExpiry: number.nullish(),
      freeTrialStatus: z.string().nullish(),
    })
    .nullish(),
  currency: z.string().nullish(),
  overageCharges: number.nullish(),
});
const responseSchema = z.object({
  nextDateReset: number.nullish(),
  usageBreakdownList: z.array(breakdownSchema).nullish(),
  subscriptionInfo: z.object({ subscriptionTitle: z.string().nullish() }).nullish(),
  overageConfiguration: z.object({ overageStatus: z.string().nullish() }).nullish(),
});
type Breakdown = z.infer<typeof breakdownSchema>;

const AWS_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;
const DEFAULT_REGION = "us-east-1";

export async function discover(
  scope: UsageScope,
  lookup: StoreLookup = {},
): Promise<UsageAccount[]> {
  if (scope.kind === "session") {
    if (scope.provider !== "kiro") return [];
    lookup = {
      ...lookup,
      env: scope.env,
      home: scope.env.HOME || scope.env.USERPROFILE || lookup.home || homedir(),
    };
  }
  const path = kiroDatabasePath(lookup);
  const login = readKiroLogin(path, lookup);
  if (!login) return [];
  return [
    {
      key: hashAccountKey(JSON.stringify([login.kind, login.profileArn ?? login.startUrl ?? path])),
      harness: "Kiro CLI",
      provider: "kiro",
      input: { path },
    },
  ];
}

/** The Q endpoint lives in the profile's region, which can differ from the login region. */
function endpointRegion(login: KiroLogin): string {
  const fromArn = login.profileArn?.split(":")[3];
  const region = fromArn || login.region || DEFAULT_REGION;
  return AWS_REGION.test(region) ? region : DEFAULT_REGION;
}

function epochSecondsToIso(seconds: number | null | undefined): string | null {
  return seconds != null ? new Date(seconds * 1000).toISOString() : null;
}

const amount = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** Two decimals keep fractional credits visible without floating-point noise. */
function percentOf(used: number | null | undefined, limit: number | null | undefined) {
  const pct = usedPctOf(used, limit);
  return pct === null ? null : Math.round(pct * 100) / 100;
}

function remainingOf(usedPct: number): number {
  return Math.round(Math.max(0, 100 - usedPct) * 100) / 100;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function readBreakdown(
  breakdown: Breakdown,
  index: number,
  fallbackReset: number | null | undefined,
): { windows: UsageWindow[]; details: UsageDetail[] } {
  const windows: UsageWindow[] = [];
  const details: UsageDetail[] = [];
  const id = breakdown.resourceType ? slug(breakdown.resourceType) : `limit_${index}`;
  const label = breakdown.displayNamePlural || breakdown.displayName || "Usage";
  const used = breakdown.currentUsageWithPrecision ?? breakdown.currentUsage;
  const limit = breakdown.usageLimitWithPrecision ?? breakdown.usageLimit;
  const usedPct = percentOf(used, limit);
  if (usedPct !== null) {
    windows.push({
      id,
      label,
      summary: index === 0,
      usedPct,
      remainingPct: remainingOf(usedPct),
      resetsAt: epochSecondsToIso(breakdown.nextDateReset ?? fallbackReset),
      tone: toneFromUsedPct(usedPct),
    });
    details.push({
      id: `${id}_used`,
      label: `${label} used`,
      value: `${amount.format(used!)} / ${amount.format(limit!)}`,
    });
  }

  const trial = breakdown.freeTrialInfo;
  if (trial && trial.freeTrialStatus?.toUpperCase() === "ACTIVE") {
    const trialUsed = trial.currentUsageWithPrecision ?? trial.currentUsage;
    const trialLimit = trial.usageLimitWithPrecision ?? trial.usageLimit;
    const trialPct = percentOf(trialUsed, trialLimit);
    if (trialPct !== null) {
      windows.push({
        id: `${id}:free_trial`,
        label: `Free trial ${label.toLowerCase()}`,
        usedPct: trialPct,
        remainingPct: remainingOf(trialPct),
        // The trial ends instead of resetting; its expiry is listed as a detail.
        resetsAt: null,
        tone: toneFromUsedPct(trialPct),
      });
    }
    const expiry = epochSecondsToIso(trial.freeTrialExpiry);
    if (expiry)
      details.push({ id: `${id}_free_trial_expiry`, label: "Free trial ends", value: expiry });
  }

  if (breakdown.overageCharges && breakdown.overageCharges > 0) {
    const currency = breakdown.currency || "USD";
    details.push({
      id: `${id}_overage_charges`,
      label: "Overage charges",
      value: new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
        breakdown.overageCharges,
      ),
      tone: "warning",
    });
  }
  return { windows, details };
}

export async function fetchUsage(
  value: unknown,
  fetchApi: typeof fetch = fetch,
  lookup: StoreLookup & { now?: () => number } = {},
): Promise<UsageReport> {
  const { path } = inputSchema.parse(value);
  const login = readKiroLogin(path, lookup);
  if (!login) throw new Error("Kiro CLI login store no longer exists");
  if (login.expiresAt !== undefined && login.expiresAt <= (lookup.now ?? Date.now)()) {
    // Kiro CLI refreshes its own token on the next run; this source never writes the store.
    return unavailable({
      kind: "expired",
      expiresAt: new Date(login.expiresAt).toISOString(),
      refreshedBy: "kiro",
    });
  }

  const url = new URL(`https://q.${endpointRegion(login)}.amazonaws.com/getUsageLimits`);
  url.searchParams.set("origin", "KIRO_CLI");
  url.searchParams.set("resourceType", "AGENTIC_REQUEST");
  if (login.profileArn) url.searchParams.set("profileArn", login.profileArn);
  const response = await fetchApi(url, {
    headers: { Authorization: `Bearer ${login.accessToken}`, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403)
    return unavailable({ kind: "rejected", status: response.status, refreshedBy: "kiro" });
  if (!response.ok) throw new Error(`Kiro usage API returned ${response.status}`);

  const usage = responseSchema.parse(await response.json());
  const windows: UsageWindow[] = [];
  const details: UsageDetail[] = [];
  (usage.usageBreakdownList ?? []).forEach((breakdown, index) => {
    const read = readBreakdown(breakdown, index, usage.nextDateReset);
    windows.push(...read.windows);
    details.push(...read.details);
  });
  if (windows.length === 0)
    return unavailable({ kind: "no_quota", detail: "No Kiro usage limits reported" });

  const overage = usage.overageConfiguration?.overageStatus;
  if (overage) {
    details.push({
      id: "overage",
      label: "Overage",
      value: overage.toUpperCase() === "ENABLED" ? "Enabled" : "Disabled",
    });
  }
  const planLabel = usage.subscriptionInfo?.subscriptionTitle?.trim() || undefined;
  return {
    status: "available",
    ...(planLabel ? { planLabel } : {}),
    windows,
    balances: [],
    details,
  };
}
