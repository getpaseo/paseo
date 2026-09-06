import type { Logger } from "pino";
import { z } from "zod";
import type { ProviderUsage, ProviderUsageDetail } from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import { ApiOptionalStringSchema, fetchProviderApi, unavailableUsage } from "../usage.js";
import { OmpUsageRunner, providerUsageFromOmpReport, type OmpUsageExec } from "./omp-usage.js";

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
  logger: Logger;
  fetch?: ProviderApiFetch;
  exec?: OmpUsageExec;
  ompCommand?: [string, ...string[]];
}

export class ZaiQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "zai";
  readonly displayName = "Z.ai";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly omp: OmpUsageRunner;

  constructor(options: ZaiQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
    this.omp = new OmpUsageRunner({
      logger: options.logger,
      command: options.ompCommand,
      exec: options.exec,
    });
  }

  async fetchUsage(): Promise<ProviderUsage> {
    // OMP owns the Z.AI coding-plan OAuth flow and knows the 5h/weekly credit
    // quota windows; its report wins whenever it has one. The legacy env-key
    // subscription listing below only identifies the plan, no usage.
    const report = await this.omp.fetchReport(this.providerId);
    const fromOmp = report
      ? providerUsageFromOmpReport({
          report,
          providerId: this.providerId,
          displayName: this.displayName,
        })
      : null;
    if (fromOmp) return fromOmp;

    return this.fetchSubscriptionStatus();
  }

  private async fetchSubscriptionStatus(): Promise<ProviderUsage> {
    const token = process.env["ZAI_API_KEY"] || process.env["GLM_API_KEY"];
    if (!token) return unavailableUsage(this);

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
      return unavailableUsage(this);
    }

    const resp = ZaiUsageResponseSchema.parse(await res.json());
    const sub = resp.data?.[0];
    if (!sub) return unavailableUsage(this);

    const details: ProviderUsageDetail[] = [];
    if (sub.status) details.push({ id: "status", label: "Status", value: sub.status });
    if (sub.valid) details.push({ id: "valid", label: "Valid", value: sub.valid });
    if (sub.purchaseTime) {
      details.push({ id: "purchase_time", label: "Purchased", value: sub.purchaseTime });
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: sub.productName || null,
      windows: [],
      balances: [],
      details,
      error: null,
    };
  }
}
