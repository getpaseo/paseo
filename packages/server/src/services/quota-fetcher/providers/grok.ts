import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { ProviderUsage, ProviderUsageBalance } from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNumberSchema,
  toneFromUsedPct,
  usedPctOf,
  fetchProviderApi,
  unavailableUsage,
} from "../usage.js";

const GrokUsageResponseSchema = z.object({
  config: z
    .object({
      monthlyLimit: z
        .object({
          val: ApiNumberSchema.optional(),
        })
        .nullish(),
    })
    .nullish(),
  usage: z
    .object({
      creditUsage: ApiNumberSchema.optional(),
    })
    .nullish(),
});

const GrokAuthSchema = z.object({
  access_token: z.string().optional(),
});

interface GrokQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
}

export class GrokQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "grok";
  readonly displayName = "Grok";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;

  constructor(options: GrokQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const token =
      process.env["GROK_API_KEY"] || process.env["GROK_TOKEN"] || (await this.readGrokToken());

    if (!token) return unavailableUsage(this);

    const res = await fetchProviderApi(
      this.fetchApi,
      "https://cli-chat-proxy.grok.com/v1/billing",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-XAI-Token-Auth": "xai-grok-cli",
          Accept: "application/json",
        },
      },
    );

    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Grok usage fetch failed");
      return unavailableUsage(this);
    }

    const resp = GrokUsageResponseSchema.parse(await res.json());
    const monthlyLimit = resp.config?.monthlyLimit?.val ?? null;
    const creditUsage = resp.usage?.creditUsage ?? null;
    const balances: ProviderUsageBalance[] = [];
    if (monthlyLimit !== null || creditUsage !== null) {
      const remaining =
        monthlyLimit !== null && creditUsage !== null
          ? Math.max(0, monthlyLimit - creditUsage)
          : null;
      balances.push({
        id: "monthly_credits",
        label: "Monthly credits",
        used: creditUsage,
        remaining,
        limit: monthlyLimit,
        unit: "credits",
        tone: toneFromUsedPct(usedPctOf(creditUsage, monthlyLimit)),
      });
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: null,
      windows: [],
      balances,
      details: [],
      error: null,
    };
  }

  private async readGrokToken(): Promise<string | null> {
    const path = join(homedir(), ".grok", "auth.json");
    if (!existsSync(path)) return null;
    try {
      const auth = GrokAuthSchema.parse(JSON.parse(await fs.readFile(path, "utf8")));
      return auth.access_token ?? null;
    } catch {
      return null;
    }
  }
}
