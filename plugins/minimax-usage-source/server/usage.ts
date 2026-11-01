import type { UsageInput } from "../shared/input.js";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { z } from "zod";
import {
  unavailable,
  type UsageAccount,
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

// The coding-plan quota endpoint the CLI itself calls. The older
// `/v1/token_plan/remains` path is not the one the agent backend serves.
const MINIMAX_CODING_PLAN_PATH = "/v1/api/openplatform/coding_plan/remains";

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

/**
 * The `mcode` CLI stores its OAuth login under `~/.minimax/auth/<env>/<region>/<clientId>/`.
 * Each client directory holds an `auth.json` with the token and an
 * `auth-state.json` with the region and expiry.
 */
const MiniMaxOAuthAuthSchema = z.object({
  schemaVersion: z.number().optional(),
  records: z.record(
    z.string(),
    z.object({
      accessToken: z.string().optional(),
      refreshToken: z.string().optional(),
      expiresAtMs: z.number().optional(),
    }),
  ),
});

const MiniMaxOAuthStateSchema = z.object({
  status: z.string().optional(),
  clientId: z.string().optional(),
  buildEnv: z.string().optional(),
  region: z.string().optional(),
  expiresAtMs: z.number().optional(),
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
  const auth = await readAuth(input);
  if (!auth) throw new Error("MiniMax login store no longer exists");
  if (auth.expiresAt && Date.parse(auth.expiresAt) <= Date.now())
    return unavailable({ kind: "expired", expiresAt: new Date(auth.expiresAt).toISOString() });

  const res = await fetchApi(`${auth.baseUrl}${MINIMAX_CODING_PLAN_PATH}`, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${auth.token}`,
      Accept: "application/json",
    },
  });

  if (res.status === 401 || res.status === 403)
    return unavailable({ kind: "rejected", status: res.status });
  if (!res.ok) throw new Error(`MiniMax usage API returned ${res.status}`);

  const resp = MiniMaxQuotaResponseSchema.parse(await res.json());

  const statusCode = resp.base_resp?.status_code;
  if (typeof statusCode === "number" && statusCode !== 0) {
    return unavailable({
      kind: "no_quota",
      detail: resp.base_resp?.status_msg ?? "No active coding plan",
    });
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

  if (windows.length === 0)
    return unavailable({ kind: "no_quota", detail: "No active coding plan" });
  return {
    status: "available",
    planLabel: undefined,
    windows,
    balances: [],
    details: [],
  };
}

async function readAuth(
  input: UsageInput,
): Promise<(MiniMaxResolvedAuth & { expiresAt?: string }) | undefined> {
  if (input.store === "env") {
    const token = process.env[input.locator];
    return token
      ? { token, baseUrl: resolveBaseUrl({ baseUrl: process.env.MINIMAX_BASE_URL }) }
      : undefined;
  }
  if (input.store === "oauth") {
    return readOAuthAuth(input);
  }
  try {
    const raw: unknown = JSON.parse(await fs.readFile(input.locator, "utf8"));
    if (input.store === "credentials") {
      const credentials = MiniMaxCredentialsSchema.parse(raw);
      return credentials.access_token
        ? {
            token: credentials.access_token,
            baseUrl: resolveBaseUrl({ baseUrl: credentials.resource_url }),
            expiresAt: credentials.expires_at ?? undefined,
          }
        : undefined;
    }
    const config = MiniMaxConfigSchema.parse(raw);
    if (config.api_key)
      return {
        token: config.api_key,
        baseUrl: resolveBaseUrl({ baseUrl: config.base_url, region: config.region }),
      };
    return config.oauth?.access_token
      ? {
          token: config.oauth.access_token,
          baseUrl: resolveBaseUrl({
            baseUrl: config.oauth.resource_url ?? config.base_url,
            region: config.region,
          }),
          expiresAt: config.oauth.expires_at ?? undefined,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the OAuth login the `mcode` CLI writes to
 * `~/.minimax/auth/<buildEnv>/<region>/<clientId>/auth.json`. The region
 * decides which host serves the account, and the token lives inside a
 * `records` map keyed by the OAuth grant.
 */
async function readOAuthAuth(
  input: UsageInput,
): Promise<(MiniMaxResolvedAuth & { expiresAt?: string }) | undefined> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(input.locator, "utf8"));
    const auth = MiniMaxOAuthAuthSchema.parse(raw);
    const record = Object.values(auth.records).find((entry) => entry.accessToken);
    if (!record?.accessToken) return undefined;

    const state = await readOAuthState(input.locator);
    const expiresAtMs = record.expiresAtMs ?? state?.expiresAtMs;
    return {
      token: record.accessToken,
      baseUrl: resolveBaseUrl({
        baseUrl: input.baseUrl,
        region: state?.region,
      }),
      expiresAt: typeof expiresAtMs === "number" ? new Date(expiresAtMs).toISOString() : undefined,
    };
  } catch {
    return undefined;
  }
}

async function readOAuthState(
  authPath: string,
): Promise<z.infer<typeof MiniMaxOAuthStateSchema> | undefined> {
  try {
    const statePath = join(dirname(authPath), "auth-state.json");
    const raw: unknown = JSON.parse(await fs.readFile(statePath, "utf8"));
    return MiniMaxOAuthStateSchema.parse(raw);
  } catch {
    return undefined;
  }
}
/**
 * Locates the `mcode` CLI's OAuth login. The layout is
 * `~/.minimax/auth/<buildEnv>/<region>/<clientId>/auth.json`, so the client
 * directory is found by scanning the region directories rather than by
 * assuming a fixed client id.
 */
async function discoverOAuthLogins(): Promise<UsageInput[]> {
  const authRoot = join(homedir(), ".minimax", "auth");
  const inputs: UsageInput[] = [];
  let buildEnvDirs: string[];
  try {
    buildEnvDirs = (await fs.readdir(authRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return inputs;
  }

  for (const buildEnv of buildEnvDirs) {
    const envRoot = join(authRoot, buildEnv);
    let regionDirs: string[];
    try {
      regionDirs = (await fs.readdir(envRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const region of regionDirs) {
      const regionRoot = join(envRoot, region);
      let clientDirs: string[];
      try {
        clientDirs = (await fs.readdir(regionRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      for (const clientId of clientDirs) {
        const authPath = join(regionRoot, clientId, "auth.json");
        const auth = await readOAuthAuth({ store: "oauth", locator: authPath });
        if (!auth) continue;
        inputs.push({
          store: "oauth",
          locator: authPath,
          baseUrl: auth.baseUrl,
        });
      }
    }
  }
  return inputs;
}

export async function discover(): Promise<UsageAccount[]> {
  const candidates: UsageInput[] = [
    { store: "env", locator: "MINIMAX_API_KEY" },
    { store: "credentials", locator: join(homedir(), ".mmx", "credentials.json") },
    { store: "config", locator: join(homedir(), ".mmx", "config.json") },
  ];
  const accounts: UsageAccount[] = [];
  for (const input of candidates)
    if (await readAuth(input)) accounts.push({ key: "default", input });
  if (accounts.length > 0) return accounts;

  const oauthInputs = await discoverOAuthLogins();
  for (const input of oauthInputs) {
    if (await readAuth(input)) {
      accounts.push({ key: "default", input });
      break;
    }
  }
  return accounts;
}
