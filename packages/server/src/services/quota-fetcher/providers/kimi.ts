import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { ProviderUsage } from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import { ApiOptionalStringSchema, fetchProviderApi, unavailableUsage } from "../usage.js";

const KimiUsageResponseSchema = z.object({
  usage: z
    .object({
      limit: ApiOptionalStringSchema,
      remaining: ApiOptionalStringSchema,
      resetTime: ApiOptionalStringSchema,
    })
    .nullish(),
});

const KimiAuthSchema = z.object({
  access_token: z.string().optional(),
});

interface KimiQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  homeDir?: string;
}

export class KimiQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "kimi";
  readonly displayName = "Kimi";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly homeDir?: string;

  constructor(options: KimiQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
    this.homeDir = options.homeDir;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const token =
      process.env["KIMI_TOKEN"] || process.env["KIMI_API_KEY"] || (await this.readKimiToken());

    if (!token) return unavailableUsage(this);

    const res = await fetchProviderApi(this.fetchApi, "https://api.kimi.com/coding/v1/usages", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Kimi usage fetch failed");
      return unavailableUsage(this);
    }

    const resp = KimiUsageResponseSchema.parse(await res.json());
    const limit = resp.usage?.limit === undefined ? null : Number(resp.usage.limit);
    const remaining = resp.usage?.remaining === undefined ? null : Number(resp.usage.remaining);
    const hasFiniteLimit = typeof limit === "number" && Number.isFinite(limit) && limit > 0;
    const hasFiniteRemaining = typeof remaining === "number" && Number.isFinite(remaining);
    const usedPct =
      hasFiniteLimit && hasFiniteRemaining
        ? Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100))
        : null;

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: null,
      windows: [
        {
          id: "coding_usage",
          label: "Coding usage",
          usedPct,
          remainingPct: usedPct === null ? null : Math.max(0, 100 - usedPct),
          resetsAt: resp.usage?.resetTime ?? null,
          tone: "ok",
        },
      ],
      balances: [],
      details: [],
      error: null,
    };
  }

  private async readKimiToken(): Promise<string | null> {
    const homeDir = this.homeDir ?? homedir();
    const paths = [
      join(
        process.env["KIMI_CODE_HOME"] || join(homeDir, ".kimi-code"),
        "credentials",
        "kimi-code.json",
      ),
      join(homeDir, ".kimi", "credentials", "kimi-code.json"),
    ];

    for (const path of paths) {
      if (!existsSync(path)) continue;
      try {
        const credentials = KimiAuthSchema.parse(JSON.parse(await fs.readFile(path, "utf8")));
        if (credentials.access_token) return credentials.access_token;
      } catch {
        continue;
      }
    }
    return null;
  }
}
