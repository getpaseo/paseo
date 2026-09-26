import type { UsageInput } from "../shared/input.js";
import { z } from "zod";
import {
  unavailableUsage,
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
  void input;

  const token = process.env["ZAI_API_KEY"] || process.env["GLM_API_KEY"];
  if (!token) return unavailableUsage();

  const res = await fetchApi("https://api.z.ai/api/biz/subscription/list", {
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    return unavailableUsage();
  }

  const resp = ZaiUsageResponseSchema.parse(await res.json());
  const sub = resp.data?.[0];
  if (!sub) return unavailableUsage();

  const details: UsageDetail[] = [];
  if (sub.status) details.push({ id: "status", label: "Status", value: sub.status });
  if (sub.valid) details.push({ id: "valid", label: "Valid", value: sub.valid });
  if (sub.purchaseTime) {
    details.push({ id: "purchase_time", label: "Purchased", value: sub.purchaseTime });
  }

  return {
    account: { key: "default" },
    status: "available",
    planLabel: sub.productName || undefined,
    windows: [],
    balances: [],
    details,
  };
}
