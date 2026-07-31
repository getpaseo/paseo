import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const KIMI_TOKEN_URL = "https://auth.kimi.com/api/oauth/token";

const KimiUsageResponseSchema = z.object({
  usage: z
    .object({
      limit: ApiOptionalStringSchema,
      remaining: ApiOptionalStringSchema,
      resetTime: ApiOptionalStringSchema,
    })
    .nullish(),
});

const KimiAuthSchema = z
  .object({
    access_token: z.string().optional(),
    refresh_token: z.string().optional(),
    expires_at: z.number().optional(),
    expires_in: z.number().optional(),
    scope: z.string().optional(),
    token_type: z.string().optional(),
  })
  .passthrough();

const KimiTokenRefreshSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.coerce.number().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

type KimiAuth = z.infer<typeof KimiAuthSchema>;
type KimiTokenRefresh = z.infer<typeof KimiTokenRefreshSchema>;

interface KimiCredentialRecord {
  credentials: KimiAuth & { access_token: string };
  filePath: string | null;
}

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
    this.logger = options.logger.child({ module: "kimi-quota-provider" });
    this.fetchApi = options.fetch ?? fetch;
    this.homeDir = options.homeDir;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const credentials = await this.readCredentials();
    if (!credentials) return unavailableUsage(this);

    let token = credentials.credentials.access_token;
    let res = await this.callUsageApi(token);

    if (res.status === 401 || res.status === 403) {
      if (!credentials.filePath || !credentials.credentials.refresh_token) {
        return unavailableUsage(this);
      }

      // Kimi Code may have refreshed the same credential file while this request was in
      // flight. Prefer that newer token before making a second refresh request ourselves.
      const latest = await this.readCredentialFile(credentials.filePath);
      if (latest?.access_token && latest.access_token !== token) {
        token = latest.access_token;
        res = await this.callUsageApi(token);
      }

      if (res.status === 401 || res.status === 403) {
        const refreshToken = latest?.refresh_token ?? credentials.credentials.refresh_token;
        const refreshed = await this.refreshToken(refreshToken);
        if (!refreshed) return unavailableUsage(this);

        const merged = this.mergeRefreshedCredentials(
          latest ?? credentials.credentials,
          refreshed,
        );
        await this.saveCredentials(credentials.filePath, merged);

        res = await this.callUsageApi(refreshed.access_token);
      }
    }

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
          tone: toneFromUsedPct(usedPct),
        },
      ],
      balances: [],
      details: [],
      error: null,
    };
  }

  private async callUsageApi(token: string): Promise<Response> {
    return fetchProviderApi(this.fetchApi, KIMI_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  }

  private async refreshToken(refreshToken: string): Promise<KimiTokenRefresh | null> {
    const body = new URLSearchParams({
      client_id: KIMI_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const res = await fetchProviderApi(this.fetchApi, KIMI_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Kimi token refresh failed");
      return null;
    }
    const parsed = KimiTokenRefreshSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  }

  private mergeRefreshedCredentials(
    existing: KimiAuth,
    refreshed: KimiTokenRefresh,
  ): KimiAuth & { access_token: string } {
    const expiresIn = refreshed.expires_in ?? existing.expires_in;
    return {
      ...existing,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token ?? existing.refresh_token,
      expires_in: expiresIn,
      expires_at: expiresIn === undefined ? existing.expires_at : Date.now() / 1000 + expiresIn,
      scope: refreshed.scope ?? existing.scope,
      token_type: refreshed.token_type ?? existing.token_type,
    };
  }

  private async saveCredentials(filePath: string, credentials: KimiAuth): Promise<void> {
    const tempPath = join(
      dirname(filePath),
      `.kimi-code.json.${process.pid}.${Date.now()}.tmp`,
    );
    try {
      await fs.writeFile(tempPath, JSON.stringify(credentials), { mode: 0o600 });
      await fs.rename(tempPath, filePath);
    } catch (error) {
      this.logger.debug({ err: error }, "Failed to persist refreshed Kimi credentials");
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private async readCredentials(): Promise<KimiCredentialRecord | null> {
    const environmentToken = process.env["KIMI_TOKEN"] || process.env["KIMI_API_KEY"];
    if (environmentToken) {
      return { credentials: { access_token: environmentToken }, filePath: null };
    }

    for (const path of this.credentialPaths()) {
      const credentials = await this.readCredentialFile(path);
      if (credentials?.access_token) {
        return {
          credentials: { ...credentials, access_token: credentials.access_token },
          filePath: path,
        };
      }
    }
    return null;
  }

  private credentialPaths(): string[] {
    const homeDir = this.homeDir ?? homedir();
    return [
      join(
        process.env["KIMI_CODE_HOME"] || join(homeDir, ".kimi-code"),
        "credentials",
        "kimi-code.json",
      ),
      join(homeDir, ".kimi", "credentials", "kimi-code.json"),
    ];
  }

  private async readCredentialFile(path: string): Promise<KimiAuth | null> {
    if (!existsSync(path)) return null;
    try {
      return KimiAuthSchema.parse(JSON.parse(await fs.readFile(path, "utf8")));
    } catch {
      return null;
    }
  }
}
