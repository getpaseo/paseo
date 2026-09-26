import { z } from "zod";
import {
  ApiOptionalStringSchema,
  fetchProviderApi,
  unavailableUsage,
  type UsageReport,
  type UsageDetail,
  type UsageApiFetch,
} from "@getpaseo/plugin/server/usage";

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

interface ZaiQuotaProviderOptions {
  logger: Console;
  fetch?: UsageApiFetch;
}

export class ZaiQuotaProvider {
  private readonly logger: Console;
  private readonly fetchApi: UsageApiFetch;

  constructor(options: ZaiQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
  }

  async fetchUsage(): Promise<UsageReport> {
    const token = process.env["ZAI_API_KEY"] || process.env["GLM_API_KEY"];
    if (!token) return unavailableUsage();

    const res = await fetchProviderApi(
      this.fetchApi,
      "https://api.z.ai/api/biz/subscription/list",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      },
    );

    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Z.ai usage fetch failed");
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
}
