import { existsSync, readdirSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type {
  ProviderUsage,
  ProviderUsageDetail,
  ProviderUsageWindow,
} from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNumberSchema,
  fetchProviderApi,
  toneFromUsedPct,
  unavailableUsage,
  windowFromUsedPct,
} from "../usage.js";

const GEMINI_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GEMINI_QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const GEMINI_TOKEN_EXPIRY_SKEW_MS = 60_000;
const GOOGLE_CLIENT_ID_RE = /\d+-[a-z0-9]+\.apps\.googleusercontent\.com/;
const GOOGLE_CLIENT_SECRET_RE = /GOCSPX-[A-Za-z0-9_-]+/;

const GeminiCredsSchema = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expiry_date: ApiNumberSchema.optional(),
});

const GeminiTokenResponseSchema = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: ApiNumberSchema.optional(),
});

const GeminiQuotaResponseSchema = z.object({
  buckets: z
    .array(
      z.object({
        modelId: z.string().nullish(),
        remainingFraction: ApiNumberSchema.nullish(),
        remainingAmount: z.coerce.string().nullish(),
        resetTime: z.string().nullish(),
      }),
    )
    .nullish(),
});

type GeminiCreds = z.infer<typeof GeminiCredsSchema>;

interface GoogleOAuthClient {
  id: string;
  secret: string;
}

let cachedOAuthClient: GoogleOAuthClient | null | undefined;

/**
 * The Gemini CLI's installed-app OAuth client is needed to refresh expired
 * ~/.gemini/oauth_creds.json tokens. It is resolved at runtime (never
 * committed): env override first, then extracted from the local gemini-cli
 * bundle (the auth chunk references oauth_creds; the secret sits next to the id).
 */
async function resolveGeminiOAuthClient(): Promise<GoogleOAuthClient | null> {
  if (cachedOAuthClient !== undefined) return cachedOAuthClient;
  cachedOAuthClient = null;
  const envId = process.env["GEMINI_OAUTH_CLIENT_ID"];
  const envSecret = process.env["GEMINI_OAUTH_CLIENT_SECRET"];
  if (envId && envSecret) {
    cachedOAuthClient = { id: envId, secret: envSecret };
    return cachedOAuthClient;
  }
  for (const dir of geminiCliBundleDirs()) {
    try {
      if (!existsSync(dir)) continue;
      const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".js"));
      let fallback: GoogleOAuthClient | null = null;
      for (const file of files) {
        const text = await fs.readFile(join(dir, file), "utf8");
        const secretMatch = text.match(GOOGLE_CLIENT_SECRET_RE);
        if (!secretMatch || secretMatch.index === undefined) continue;
        const window = text.slice(
          Math.max(0, secretMatch.index - 500),
          secretMatch.index + 500,
        );
        const id = window.match(GOOGLE_CLIENT_ID_RE)?.[0];
        if (!id) continue;
        const client = { id, secret: secretMatch[0] };
        if (text.includes("oauth_creds")) {
          cachedOAuthClient = client;
          return cachedOAuthClient;
        }
        fallback ??= client;
      }
      if (fallback) {
        cachedOAuthClient = fallback;
        return cachedOAuthClient;
      }
    } catch {
      continue;
    }
  }
  return cachedOAuthClient;
}

function geminiCliBundleDirs(): string[] {
  const dirs: string[] = [];
  if (process.env["GEMINI_CLI_BUNDLE_DIR"]) dirs.push(process.env["GEMINI_CLI_BUNDLE_DIR"]);
  if (process.platform === "win32") {
    const appData = process.env["APPDATA"];
    if (appData) {
      dirs.push(join(appData, "npm", "node_modules", "@google", "gemini-cli", "bundle"));
    }
  }
  const nvmRoot = join(homedir(), ".nvm", "versions", "node");
  try {
    if (existsSync(nvmRoot)) {
      for (const ver of readdirSync(nvmRoot)) {
        dirs.push(join(nvmRoot, ver, "lib", "node_modules", "@google", "gemini-cli", "bundle"));
      }
    }
  } catch {
    // No nvm layout; nothing more to try.
  }
  return dirs;
}

interface GeminiQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  /** Code Assist project; defaults to GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_QUOTA_PROJECT. */
  projectId?: string;
}

export class GeminiQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "gemini";
  readonly displayName = "Gemini";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly projectId: string | undefined;

  constructor(options: GeminiQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
    this.projectId =
      options.projectId ??
      process.env["GOOGLE_CLOUD_PROJECT"] ??
      process.env["GOOGLE_CLOUD_QUOTA_PROJECT"];
  }

  async fetchUsage(): Promise<ProviderUsage> {
    if (!this.projectId) {
      return unavailableUsage({
        providerId: this.providerId,
        displayName: this.displayName,
        error: "no Code Assist project (set GOOGLE_CLOUD_PROJECT)",
      });
    }
    const token = await this.readAccessToken();
    if (!token) return unavailableUsage(this);

    const res = await fetchProviderApi(this.fetchApi, GEMINI_QUOTA_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ project: this.projectId }),
    });

    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Gemini quota fetch failed");
      return unavailableUsage(this);
    }

    const resp = GeminiQuotaResponseSchema.parse(await res.json());
    const windows: ProviderUsageWindow[] = [];
    for (const bucket of resp.buckets ?? []) {
      if (!bucket.modelId || bucket.remainingFraction == null) continue;
      const usedPct = Math.max(0, Math.min(100, (1 - bucket.remainingFraction) * 100));
      windows.push(
        windowFromUsedPct({
          id: `model_${bucket.modelId}`,
          label: bucket.modelId,
          utilizationPct: usedPct,
          resetsAt: bucket.resetTime ?? null,
          tone: toneFromUsedPct(usedPct),
        }),
      );
    }
    windows.sort((a, b) => (b.usedPct ?? -1) - (a.usedPct ?? -1));

    const details: ProviderUsageDetail[] = [
      { id: "project", label: "Project", value: this.projectId },
    ];

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: null,
      windows,
      balances: [],
      details,
      error: null,
    };
  }

  private async readAccessToken(): Promise<string | null> {
    for (const path of this.candidateCredPaths()) {
      const token = await this.readTokenFromFile(path);
      if (token) return token;
    }
    return null;
  }

  private candidateCredPaths(): string[] {
    const paths: string[] = [];
    if (process.env["GEMINI_OAUTH_CREDS"]) paths.push(process.env["GEMINI_OAUTH_CREDS"]);
    paths.push(join(homedir(), ".gemini", "oauth_creds.json"));
    return paths;
  }

  private async readTokenFromFile(path: string): Promise<string | null> {
    if (!existsSync(path)) return null;
    let raw: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      raw = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
    const creds = GeminiCredsSchema.safeParse(raw);
    if (!creds.success || !creds.data.access_token) return null;
    const expiry = creds.data.expiry_date;
    const fresh =
      typeof expiry !== "number" || expiry > Date.now() + GEMINI_TOKEN_EXPIRY_SKEW_MS;
    if (fresh) return creds.data.access_token;
    if (!creds.data.refresh_token) return null;
    return this.refreshCreds(path, raw, creds.data);
  }

  private async refreshCreds(
    path: string,
    raw: Record<string, unknown>,
    creds: GeminiCreds,
  ): Promise<string | null> {
    const client = await resolveGeminiOAuthClient();
    if (!client) return null;
    try {
      const res = await fetchProviderApi(this.fetchApi, GEMINI_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.id,
          client_secret: client.secret,
          refresh_token: creds.refresh_token as string,
          grant_type: "refresh_token",
        }).toString(),
      });
      if (!res.ok) return null;
      const tok = GeminiTokenResponseSchema.parse(await res.json());
      if (!tok.access_token) return null;

      raw["access_token"] = tok.access_token;
      if (tok.refresh_token) raw["refresh_token"] = tok.refresh_token;
      raw["expiry_date"] = Date.now() + Number(tok.expires_in ?? 3600) * 1000;
      await fs.writeFile(path, JSON.stringify(raw, null, 2));
      return tok.access_token;
    } catch {
      return null;
    }
  }
}
