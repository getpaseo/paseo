import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { ProviderUsage } from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiOptionalStringSchema,
  fetchProviderApi,
  toneFromUsedPct,
  unavailableUsage,
} from "../usage.js";

const KimiQuotaDetailSchema = z.object({
  limit: ApiOptionalStringSchema,
  used: ApiOptionalStringSchema,
  remaining: ApiOptionalStringSchema,
  resetTime: ApiOptionalStringSchema,
});

// The rolling rate-limit windows (the 5-hour one today) live in a `limits[]` array
// rather than the top-level `usage` key. Entries are validated one at a time in
// fetchUsage so a single malformed or newly-shaped entry cannot take down the windows
// that already parsed.
const KimiRateLimitSchema = z.object({
  window: z
    .object({
      duration: z.number(),
      timeUnit: z.string(),
    })
    .nullish(),
  detail: KimiQuotaDetailSchema.nullish(),
});

const KimiUsageResponseSchema = z.object({
  usage: KimiQuotaDetailSchema.nullish(),
  // Deliberately permissive: an additive section must never regress the top-level
  // window, so shape validation happens per entry rather than here.
  limits: z.array(z.unknown()).nullish(),
});

const KimiAuthSchema = z.object({
  access_token: z.string().optional(),
});

type KimiQuotaDetail = z.infer<typeof KimiQuotaDetailSchema>;
type KimiRateLimitWindow = NonNullable<z.infer<typeof KimiRateLimitSchema>["window"]>;

interface KimiQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  homeDir?: string;
}

function toFiniteNumber(value: string | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Percentage consumed within one quota window. `remaining` is the value the API always
 * sends; `used` is the fallback for windows that omit it.
 */
function usedPctFromDetail(detail: KimiQuotaDetail | null | undefined): number | null {
  const limit = toFiniteNumber(detail?.limit);
  if (limit === null || limit <= 0) return null;
  let remaining = toFiniteNumber(detail?.remaining);
  if (remaining === null) {
    const used = toFiniteNumber(detail?.used);
    remaining = used === null ? null : limit - used;
  }
  if (remaining === null) return null;
  return Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100));
}

/**
 * Identity of one rate-limit window, derived from its proto-style duration. The API
 * expresses the 5-hour window as 300 minutes; normalize to the largest whole unit so
 * the label reads "5-hour limit" rather than "300-minute limit". Unknown units return
 * null so the entry is skipped instead of mislabelled.
 */
function rateLimitIdentity(window: KimiRateLimitWindow): { id: string; label: string } | null {
  let duration = window.duration;
  let unit: "minute" | "hour" | "day";
  switch (window.timeUnit) {
    case "TIME_UNIT_MINUTE":
      unit = "minute";
      break;
    case "TIME_UNIT_HOUR":
      unit = "hour";
      break;
    case "TIME_UNIT_DAY":
      unit = "day";
      break;
    default:
      return null;
  }
  if (unit === "minute" && duration % 60 === 0) {
    duration /= 60;
    unit = "hour";
  }
  return { id: `rate_limit_${duration}_${unit}`, label: `${duration}-${unit} limit` };
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
    const usedPct = usedPctFromDetail(resp.usage);

    const windows: ProviderUsage["windows"] = [
      {
        id: "coding_usage",
        label: "Coding usage",
        usedPct,
        remainingPct: usedPct === null ? null : Math.max(0, 100 - usedPct),
        resetsAt: resp.usage?.resetTime ?? null,
        tone: toneFromUsedPct(usedPct),
      },
    ];

    for (const entry of resp.limits ?? []) {
      const parsed = KimiRateLimitSchema.safeParse(entry);
      if (!parsed.success || !parsed.data.window || !parsed.data.detail) continue;
      const identity = rateLimitIdentity(parsed.data.window);
      if (identity === null) continue;
      const entryUsedPct = usedPctFromDetail(parsed.data.detail);
      windows.push({
        id: identity.id,
        label: identity.label,
        usedPct: entryUsedPct,
        remainingPct: entryUsedPct === null ? null : Math.max(0, 100 - entryUsedPct),
        resetsAt: parsed.data.detail.resetTime ?? null,
        tone: toneFromUsedPct(entryUsedPct),
      });
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: null,
      windows,
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
