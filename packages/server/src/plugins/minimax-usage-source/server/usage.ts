import type { UsageInput } from "../shared/input.js";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  unavailableUsage,
  windowFromUsedPct,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";

const ApiNumberSchema = z.coerce.number().finite();
const ApiOptionalStringSchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.coerce.string().optional(),
);

const MINIMAX_GLOBAL_BASE_URL = "https://api.minimax.io";
const MINIMAX_CN_BASE_URL = "https://api.minimaxi.com";

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

/**
 * MiniMax reports application-level failures inside a 200 response: `base_resp.status_code`
 * is non-zero and `model_remains` comes back as null. An account with no token plan
 * subscription is the common case (status 2062), so both shapes are normal input here.
 */
const MiniMaxBaseRespSchema = z.object({
  status_code: ApiNumberSchema.optional(),
  status_msg: ApiOptionalStringSchema,
});

const MiniMaxQuotaResponseSchema = z.object({
  model_remains: z.array(MiniMaxModelRemainSchema).nullish(),
  base_resp: MiniMaxBaseRespSchema.nullish(),
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

function toneForStatus(status: number | null | undefined): UsageWindow["tone"] {
  if (status === 2) return "danger";
  if (status === 3) return "default";
  return "ok";
}

function toIntervalWindow(modelName: string, model: MiniMaxModelRemain): UsageWindow | null {
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

function toWeeklyWindow(modelName: string, model: MiniMaxModelRemain): UsageWindow | null {
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

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  void input;
  const configPath = join(homedir(), ".mmx", "config.json");
  const credentialsPath = join(homedir(), ".mmx", "credentials.json");
  const env = process.env;
  const now = Date.now;

  async function resolveAuth(): Promise<MiniMaxResolvedAuth | null> {
    const envToken = env["MINIMAX_API_KEY"];
    if (envToken) {
      const envBase = env["MINIMAX_BASE_URL"];
      return {
        token: envToken,
        baseUrl: resolveBaseUrl({ baseUrl: envBase }),
      };
    }

    const credentials = await readCredentials();
    if (credentials?.access_token && !isExpired(credentials.expires_at)) {
      return {
        token: credentials.access_token,
        baseUrl: resolveBaseUrl({ baseUrl: credentials.resource_url }),
      };
    }

    const config = await readConfig();
    if (config?.api_key) {
      return {
        token: config.api_key,
        baseUrl: resolveBaseUrl({
          baseUrl: config.base_url,
          region: config.region,
        }),
      };
    }

    if (config?.oauth?.access_token && !isExpired(config.oauth.expires_at)) {
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

  function isExpired(expiresAt: string | null | undefined): boolean {
    if (!expiresAt) return false;
    const parsed = Date.parse(expiresAt);
    if (!Number.isFinite(parsed)) return false;
    return parsed <= now();
  }

  async function readCredentials(): Promise<z.infer<typeof MiniMaxCredentialsSchema> | null> {
    if (!existsSync(credentialsPath)) return null;
    try {
      const raw = JSON.parse(await fs.readFile(credentialsPath, "utf8"));
      return MiniMaxCredentialsSchema.parse(raw);
    } catch {
      return null;
    }
  }

  async function readConfig(): Promise<z.infer<typeof MiniMaxConfigSchema> | null> {
    if (!existsSync(configPath)) return null;
    try {
      const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
      return MiniMaxConfigSchema.parse(raw);
    } catch {
      return null;
    }
  }

  const auth = await resolveAuth();
  if (!auth) return unavailableUsage();

  const res = await fetchApi(`${auth.baseUrl}/v1/token_plan/remains`, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${auth.token}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    return unavailableUsage();
  }

  const resp = MiniMaxQuotaResponseSchema.parse(await res.json());

  const statusCode = resp.base_resp?.status_code;
  if (typeof statusCode === "number" && statusCode !== 0) {
    return unavailableUsage();
  }

  const models = resp.model_remains ?? [];

  const windows: UsageWindow[] = [];
  for (const model of models) {
    const name = model.model_name ?? "token-plan";
    const intervalWindow = toIntervalWindow(name, model);
    if (intervalWindow) windows.push(intervalWindow);
    const weeklyWindow = toWeeklyWindow(name, model);
    if (weeklyWindow) windows.push(weeklyWindow);
  }
  if (windows[0]) windows[0].headline = true;

  return {
    account: { key: "default" },
    status: windows.length > 0 ? "available" : "unavailable",
    planLabel: undefined,
    windows,
    balances: [],
    details: [],
  };
}
