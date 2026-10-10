import type { UsageInput } from "../shared/input.js";
import { z } from "zod";
import {
  unavailable,
  type UsageAccount,
  type UsageReport,
  type UsageDetail,
} from "@getpaseo/plugin/server/usage";

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

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  const token = process.env[input.locator];
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

  return {
    status: "available",
    planLabel: sub.productName || undefined,
    windows: [],
    balances: [],
    details,
  };
}

export async function discover(): Promise<UsageAccount[]> {
  for (const locator of ["ZAI_API_KEY", "GLM_API_KEY"]) {
    if (process.env[locator]) return [{ key: "default", input: { store: "env", locator } }];
  }
  return [];
}
