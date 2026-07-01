import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { ProviderUsage, ProviderUsageWindow } from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNumberSchema,
  ApiOptionalStringSchema,
  fetchProviderApi,
  unavailableUsage,
  windowFromUsedPct,
} from "../usage.js";

const MINIMAX_GLOBAL_BASE_URL = "https://api.minimax.io";
const MINIMAX_CN_BASE_URL = "https://api.minimaxi.com";
const MINIMAX_CREDENTIALS_PATH = join(homedir(), ".mmx", "credentials.json");
const MINIMAX_CONFIG_PATH = join(homedir(), ".mmx", "config.json");

const MiniMaxModelRemainSchema = z.object({
  model_name: ApiOptionalStringSchema,
  start_time: ApiNumberSchema.optional(),
  end_time: ApiNumberSchema.optional(),
  remains_time: ApiNumberSchema.optional(),
  current_interval_total_count: ApiNumberSchema.optional(),
  current_interval_usage_count: ApiNumberSchema.optional(),
  current_interval_remaining_percent: ApiNumberSchema.optional(),
  current_weekly_total_count: ApiNumberSchema.optional(),
  current_weekly_usage_count: ApiNumberSchema.optional(),
  current_weekly_remaining_percent: ApiNumberSchema.optional(),
  current_interval_status: ApiNumberSchema.optional(),
  current_weekly_status: ApiNumberSchema.optional(),
  weekly_start_time: ApiNumberSchema.optional(),
  weekly_end_time: ApiNumberSchema.optional(),
  weekly_remains_time: ApiNumberSchema.optional(),
  weekly_boost_permille: ApiNumberSchema.optional(),
});

const MiniMaxQuotaResponseSchema = z.object({
  model_remains: z.array(MiniMaxModelRemainSchema).optional(),
});

const MiniMaxCredentialsSchema = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_at: ApiOptionalStringSchema,
  resource_url: ApiOptionalStringSchema,
});

const MiniMaxConfigSchema = z.object({
  api_key: z.string().optional(),
  region: z.string().optional(),
  base_url: ApiOptionalStringSchema,
  oauth: MiniMaxCredentialsSchema.optional(),
});

type MiniMaxModelRemain = z.infer<typeof MiniMaxModelRemainSchema>;

interface MiniMaxResolvedAuth {
  token: string;
  baseUrl: string;
}

interface MiniMaxQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  configPath?: string;
  credentialsPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

function resolveBaseUrl(input: { baseUrl?: string; region?: string }): string {
  const explicit = input.baseUrl;
  if (explicit && explicit.startsWith("http")) return explicit;
  if (input.region === "cn") return MINIMAX_CN_BASE_URL;
  return MINIMAX_GLOBAL_BASE_URL;
}

function computeUsedPct(
  remaining: number | null | undefined,
  total: number | null | undefined,
): number | null {
  if (typeof remaining !== "number" || typeof total !== "number") return null;
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(remaining)) return null;
  const used = total - remaining;
  return Math.max(0, Math.min(100, (used / total) * 100));
}

function epochMsToIso(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value).toISOString();
}

function toneForStatus(status: number | null | undefined): ProviderUsageWindow["tone"] {
  if (status === 2) return "danger";
  if (status === 3) return "default";
  return "ok";
}

function toIntervalWindow(
  modelName: string,
  model: MiniMaxModelRemain,
): ProviderUsageWindow | null {
  const total = model.current_interval_total_count ?? null;
  const used = model.current_interval_usage_count ?? null;
  const remainingPercent = model.current_interval_remaining_percent ?? null;
  const usedPct =
    typeof remainingPercent === "number" && Number.isFinite(remainingPercent)
      ? Math.max(0, Math.min(100, 100 - remainingPercent))
      : computeUsedPct(
          typeof total === "number" && typeof used === "number" ? total - used : null,
          total,
        );
  if (usedPct === null) return null;
  return windowFromUsedPct({
    id: `interval_${modelName}`,
    label: `${modelName} · Interval`,
    utilizationPct: usedPct,
    resetsAt: epochMsToIso(model.end_time),
    tone: toneForStatus(model.current_interval_status),
  });
}

function toWeeklyWindow(modelName: string, model: MiniMaxModelRemain): ProviderUsageWindow | null {
  const total = model.current_weekly_total_count ?? null;
  const used = model.current_weekly_usage_count ?? null;
  const remainingPercent = model.current_weekly_remaining_percent ?? null;
  let usedPct: number | null = null;
  if (typeof remainingPercent === "number" && Number.isFinite(remainingPercent)) {
    usedPct = Math.max(0, Math.min(100, 100 - remainingPercent));
  } else if (typeof total === "number" && typeof used === "number") {
    usedPct = computeUsedPct(total - used, total);
  }
  if (usedPct === null) return null;
  return windowFromUsedPct({
    id: `weekly_${modelName}`,
    label: `${modelName} · Weekly`,
    utilizationPct: usedPct,
    resetsAt: epochMsToIso(model.weekly_end_time),
    tone: toneForStatus(model.current_weekly_status),
  });
}

export class MiniMaxQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "minimax";
  readonly displayName = "MiniMax";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly configPath: string;
  private readonly credentialsPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;

  constructor(options: MiniMaxQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
    this.configPath = options.configPath ?? MINIMAX_CONFIG_PATH;
    this.credentialsPath = options.credentialsPath ?? MINIMAX_CREDENTIALS_PATH;
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const auth = await this.resolveAuth();
    if (!auth) return unavailableUsage(this);

    const res = await fetchProviderApi(this.fetchApi, `${auth.baseUrl}/v1/token_plan/remains`, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      this.logger.debug({ status: res.status }, "MiniMax usage fetch failed");
      return unavailableUsage(this);
    }

    const resp = MiniMaxQuotaResponseSchema.parse(await res.json());
    const models = resp.model_remains ?? [];

    const windows: ProviderUsageWindow[] = [];
    for (const model of models) {
      const name = model.model_name ?? "token-plan";
      const intervalWindow = toIntervalWindow(name, model);
      if (intervalWindow) windows.push(intervalWindow);
      const weeklyWindow = toWeeklyWindow(name, model);
      if (weeklyWindow) windows.push(weeklyWindow);
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: windows.length > 0 ? "available" : "unavailable",
      planLabel: null,
      windows,
      balances: [],
      details: [],
      error: null,
    };
  }

  private async resolveAuth(): Promise<MiniMaxResolvedAuth | null> {
    const envToken = this.env["MINIMAX_API_KEY"];
    if (envToken) {
      const envBase = this.env["MINIMAX_BASE_URL"];
      return {
        token: envToken,
        baseUrl: resolveBaseUrl({ baseUrl: envBase }),
      };
    }

    const credentials = await this.readCredentials();
    if (credentials?.access_token && !this.isExpired(credentials.expires_at)) {
      return {
        token: credentials.access_token,
        baseUrl: resolveBaseUrl({ baseUrl: credentials.resource_url }),
      };
    }

    const config = await this.readConfig();
    if (config?.api_key) {
      return {
        token: config.api_key,
        baseUrl: resolveBaseUrl({
          baseUrl: config.base_url,
          region: config.region,
        }),
      };
    }

    if (config?.oauth?.access_token && !this.isExpired(config.oauth.expires_at)) {
      return {
        token: config.oauth.access_token,
        baseUrl: resolveBaseUrl({
          baseUrl: config.oauth.resource_url ?? config.base_url,
          region: config.region,
        }),
      };
    }

    return null;
  }

  private isExpired(expiresAt: string | null | undefined): boolean {
    if (!expiresAt) return false;
    const parsed = Date.parse(expiresAt);
    if (!Number.isFinite(parsed)) return false;
    return parsed <= this.now();
  }

  private async readCredentials(): Promise<z.infer<typeof MiniMaxCredentialsSchema> | null> {
    if (!existsSync(this.credentialsPath)) return null;
    try {
      const raw = JSON.parse(await fs.readFile(this.credentialsPath, "utf8"));
      return MiniMaxCredentialsSchema.parse(raw);
    } catch {
      return null;
    }
  }

  private async readConfig(): Promise<z.infer<typeof MiniMaxConfigSchema> | null> {
    if (!existsSync(this.configPath)) return null;
    try {
      const raw = JSON.parse(await fs.readFile(this.configPath, "utf8"));
      return MiniMaxConfigSchema.parse(raw);
    } catch {
      return null;
    }
  }
}
