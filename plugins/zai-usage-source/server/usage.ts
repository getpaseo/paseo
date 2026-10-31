import type { UsageInput } from "../shared/input.js";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  unavailable,
  type UsageAccount,
  type UsageReport,
  type UsageDetail,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { readZCodeApiKey } from "./zcode-credentials.js";

const ApiOptionalStringSchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.coerce.string().optional(),
);

const ZaiUsageResponseSchema = z.object({
  data: z
    .array(
      z.object({
        productName: ApiOptionalStringSchema,
        status: ApiOptionalStringSchema,
        purchaseTime: ApiOptionalStringSchema,
        valid: ApiOptionalStringSchema,
      }),
    )
    .optional(),
});

/**
 * The Z.ai coding-plan quota endpoint. The monitor API takes the credential
 * as-is: it rejects a `Bearer` prefix, so the header carries the raw key.
 */
const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const ZAI_SUBSCRIPTION_URL = "https://api.z.ai/api/biz/subscription/list";

const QuotaLimitSchema = z.object({
  type: z.string().optional(),
  unit: z.number().optional(),
  number: z.number().optional(),
  usage: z.number().optional(),
  currentValue: z.number().optional(),
  remaining: z.number().optional(),
  percentage: z.number().optional(),
  nextResetTime: z.number().optional(),
});

type QuotaLimit = z.infer<typeof QuotaLimitSchema>;

const BigModelQuotaResponseSchema = z.object({
  code: z.number().optional(),
  msg: z.string().optional(),
  success: z.boolean().optional(),
  data: z
    .object({
      level: z.string().optional(),
      limits: z.array(QuotaLimitSchema).optional(),
    })
    .nullish(),
});

/**
 * The quota windows the coding plan reports. `unit` and `number` identify the
 * window: unit 3 with number 5 is the five-hour window, unit 6 is the weekly
 * one. The token and credit limit types are the same window under different
 * names, depending on which business host answered.
 */
const TOKEN_LIMIT_TYPES = new Set(["TOKENS_LIMIT", "CREDIT_LIMIT"]);

function windowLabel(limit: { unit?: number; number?: number; type?: string }): string {
  if (limit.unit === 3) return limit.number ? `${limit.number}-hour limit` : "Hourly limit";
  if (limit.unit === 6) return "Weekly limit";
  if (limit.unit === 4) return "Daily limit";
  if (limit.unit === 5) return "Monthly limit";
  return TOKEN_LIMIT_TYPES.has(limit.type ?? "") ? "Usage limit" : "Limit";
}

/**
 * The percentage the API reports is the share still available, so the share
 * used is its complement.
 */
function usedPct(limit: {
  percentage?: number;
  currentValue?: number;
  usage?: number;
}): number | null {
  if (typeof limit.percentage === "number" && Number.isFinite(limit.percentage)) {
    return Math.max(0, Math.min(100, 100 - limit.percentage));
  }
  const current = limit.currentValue;
  const total = limit.usage;
  if (
    typeof current !== "number" ||
    typeof total !== "number" ||
    !Number.isFinite(current) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return null;
  }
  return Math.max(0, Math.min(100, (current / total) * 100));
}

function resetsAtIso(nextResetTime: number | undefined): string | null {
  if (typeof nextResetTime !== "number" || !Number.isFinite(nextResetTime) || nextResetTime <= 0) {
    return null;
  }
  return new Date(nextResetTime).toISOString();
}

function quotaWindows(limits: readonly QuotaLimit[]): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const limit of limits) {
    const type = limit.type ?? "";
    if (!TOKEN_LIMIT_TYPES.has(type)) continue;
    const pct = usedPct(limit);
    if (pct === null) continue;
    const label = windowLabel(limit);
    windows.push({
      id: `quota_${limit.unit ?? "x"}_${limit.number ?? "x"}`,
      label,
      usedPct: pct,
      remainingPct: Math.max(0, Math.min(100, 100 - pct)),
      resetsAt: resetsAtIso(limit.nextResetTime),
      tone: pct >= 100 ? "danger" : "ok",
    });
  }
  return windows;
}

/**
 * The API key the `glm-acp-agent` CLI writes. The CLI names the variable
 * `Z_AI_API_KEY`; the older `ZAI_API_KEY` spelling is still accepted.
 */
const ZaiCredentialsSchema = z.object({
  z_ai_api_key: z.string().optional(),
});

async function readToken(input: UsageInput): Promise<string | undefined> {
  if (input.store === "env") {
    return process.env[input.locator];
  }
  if (input.store === "zcode") {
    return readZCodeApiKey();
  }
  try {
    const raw: unknown = JSON.parse(await fs.readFile(input.locator, "utf8"));
    return ZaiCredentialsSchema.parse(raw).z_ai_api_key;
  } catch {
    return undefined;
  }
}

/**
 * The plan name and validity come from the subscription list, which the quota
 * endpoint does not carry. A failure here does not invalidate the quota.
 */
async function fetchPlanDetails(
  token: string,
  fetchApi: typeof fetch,
): Promise<{ planLabel?: string; details: UsageDetail[] }> {
  const details: UsageDetail[] = [];
  try {
    const res = await fetchApi(ZAI_SUBSCRIPTION_URL, {
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) return { details };

    const sub = ZaiUsageResponseSchema.parse(await res.json());
    const plan = sub.data?.[0];
    if (!plan) return { details };

    if (plan.status) details.push({ id: "status", label: "Status", value: plan.status });
    if (plan.valid) details.push({ id: "valid", label: "Valid", value: plan.valid });
    if (plan.purchaseTime) {
      details.push({ id: "purchase_time", label: "Purchased", value: plan.purchaseTime });
    }
    return { planLabel: plan.productName || undefined, details };
  } catch {
    return { details };
  }
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  const token = await readToken(input);
  if (!token) throw new Error("Z.ai login store no longer exists");

  const quotaRes = await fetchApi(ZAI_QUOTA_URL, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      // The monitor API takes the credential as-is and rejects a Bearer prefix.
      Authorization: token,
      Accept: "application/json",
    },
  });

  if (quotaRes.status === 401 || quotaRes.status === 403)
    return unavailable({ kind: "rejected", status: quotaRes.status });
  if (!quotaRes.ok) throw new Error(`Z.ai usage API returned ${quotaRes.status}`);

  const quota = BigModelQuotaResponseSchema.parse(await quotaRes.json());
  if (quota.code !== undefined && quota.code !== 0 && quota.success === false) {
    return unavailable({ kind: "no_quota", detail: quota.msg ?? "No active coding plan" });
  }

  const windows = quotaWindows(quota.data?.limits ?? []);
  const plan = await fetchPlanDetails(token, fetchApi);

  if (windows.length === 0 && !plan.planLabel) {
    return unavailable({ kind: "no_quota", detail: "No active coding plan" });
  }

  return {
    status: "available",
    planLabel: plan.planLabel,
    windows,
    balances: [],
    details: plan.details,
  };
}

export async function discover(): Promise<UsageAccount[]> {
  for (const locator of ["Z_AI_API_KEY", "ZAI_API_KEY", "GLM_API_KEY"]) {
    if (process.env[locator]) return [{ key: "default", input: { store: "env", locator } }];
  }

  const credentialsPath = join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "glm-acp-agent",
    "credentials.json",
  );
  if (await readToken({ store: "file", locator: credentialsPath })) {
    return [{ key: "default", input: { store: "file", locator: credentialsPath } }];
  }

  // The ZCode desktop app keeps the Coding Plan key of the signed-in account
  // in its own store, encrypted with a key derived from the machine. Reading it
  // reports the quota the account is actually billed against.
  const zcodeKey = await readZCodeApiKey();
  if (zcodeKey) {
    return [{ key: "default", input: { store: "zcode", locator: "api-key" } }];
  }

  return [];
}
