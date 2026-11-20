import type { UsageInput } from "../shared/input.js";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  unavailable,
  windowFromUsedPct,
  type UsageAccount,
  type UsageReport,
  type UsageDetail,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";

const ApiOptionalStringSchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.coerce.string().optional(),
);

const ApiOptionalNumberSchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.coerce.number().optional(),
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

// Coding-plan credit pools from GET /api/monitor/usage/quota/limit.
// unit 3 is the 5-hour pool, unit 6 the weekly one.
const ZaiQuotaResponseSchema = z.object({
  data: z
    .object({
      limits: z
        .array(
          z.object({
            type: ApiOptionalStringSchema,
            unit: ApiOptionalNumberSchema,
            usage: ApiOptionalNumberSchema,
            currentValue: ApiOptionalNumberSchema,
            percentage: ApiOptionalNumberSchema,
            nextResetTime: ApiOptionalNumberSchema,
          }),
        )
        .optional(),
      level: ApiOptionalStringSchema,
    })
    .optional(),
});

const CreditPools: Record<number, { id: string; label: string }> = {
  3: { id: "credits_5h", label: "5-hour credit pool" },
  6: { id: "credits_weekly", label: "Weekly credit pool" },
};

// The ZCode CLI (Z.ai's coding harness) persists the coding-plan key at
// ~/.zcode/v2/config.json — the counterpart of the gh hosts.yml lookup.
function zcodeConfigPath(): string {
  return join(homedir(), ".zcode", "v2", "config.json");
}

async function readToken(input: UsageInput): Promise<string | undefined> {
  if (input.store === "env") return process.env[input.locator];
  try {
    const raw = await fs.readFile(input.locator, "utf8");
    const apiKey = JSON.parse(raw)?.provider?.["builtin:zai-coding-plan"]?.options?.apiKey;
    return typeof apiKey === "string" && apiKey.length > 0 ? apiKey : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  const token = await readToken(input);
  if (!token) throw new Error("Z.ai login store no longer exists");

  const res = await fetchApi("https://api.z.ai/api/biz/subscription/list", {
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (res.status === 401 || res.status === 403)
    return unavailable({ kind: "rejected", status: res.status });
  if (!res.ok) throw new Error(`Z.ai usage API returned ${res.status}`);

  const resp = ZaiUsageResponseSchema.parse(await res.json());
  const sub = resp.data?.[0];
  if (!sub) return unavailable({ kind: "no_quota", detail: "No active coding plan" });

  const details: UsageDetail[] = [];
  if (sub.status) details.push({ id: "status", label: "Status", value: sub.status });
  if (sub.valid) details.push({ id: "valid", label: "Valid", value: sub.valid });
  if (sub.purchaseTime) {
    details.push({ id: "purchase_time", label: "Purchased", value: sub.purchaseTime });
  }

  const windows: UsageWindow[] = [];
  try {
    const quotaRes = await fetchApi("https://api.z.ai/api/monitor/usage/quota/limit", {
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    if (quotaRes.ok) {
      const quota = ZaiQuotaResponseSchema.parse(await quotaRes.json());
      for (const limit of quota.data?.limits ?? []) {
        const pool = limit.unit != null ? CreditPools[limit.unit] : undefined;
        if (limit.type !== "CREDIT_LIMIT" || !pool) continue;
        // Right after a window reset the API omits percentage and
        // nextResetTime on the fresh entry; derive the share from the credit
        // counts instead of dropping the window.
        const usedPct =
          limit.percentage ??
          (limit.currentValue != null && limit.usage
            ? Math.floor((limit.currentValue / limit.usage) * 100)
            : 0);
        windows.push(
          windowFromUsedPct({
            id: pool.id,
            label: pool.label,
            utilizationPct: usedPct,
            resetsAt:
              limit.nextResetTime != null
                ? new Date(limit.nextResetTime).toISOString()
                : undefined,
          }),
        );
        if (limit.currentValue != null && limit.usage != null) {
          details.push({
            id: `${pool.id}_used`,
            label: `${pool.label} used`,
            value: `${limit.currentValue} / ${limit.usage}`,
          });
        }
      }
      if (quota.data?.level) {
        details.push({ id: "plan_level", label: "Plan level", value: quota.data.level });
      }
    }
  } catch {
    // Quota endpoint unreachable or reshaped — the plan-status report stands.
  }

  return {
    status: "available",
    planLabel: sub.productName || undefined,
    windows,
    balances: [],
    details,
  };
}

export async function discover(): Promise<UsageAccount[]> {
  for (const locator of ["ZAI_API_KEY", "GLM_API_KEY"]) {
    if (process.env[locator]) return [{ key: "default", input: { store: "env", locator } }];
  }
  const locator = zcodeConfigPath();
  if (await readToken({ store: "file", locator })) {
    return [{ key: "default", input: { store: "file", locator } }];
  }
  return [];
}
