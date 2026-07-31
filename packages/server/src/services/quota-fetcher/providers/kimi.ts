import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { ProviderUsage } from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNumberSchema,
  fetchProviderApi,
  unavailableUsage,
} from "../usage.js";
import { kimiUsageWindowsFromPayload } from "./kimi-usage.js";

const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const KIMI_TOKEN_URL = "https://auth.kimi.com/api/oauth/token";

const KimiAuthSchema = z
  .object({
    access_token: z.string().nullish(),
    refresh_token: z.string().nullish(),
    expires_at: ApiNumberSchema.nullish(),
    expires_in: ApiNumberSchema.nullish(),
    scope: z.string().nullish(),
    token_type: z.string().nullish(),
  })
  .passthrough();

const KimiTokenRefreshSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().nullish(),
  expires_in: ApiNumberSchema.nullish(),
  scope: z.string().nullish(),
  token_type: z.string().nullish(),
});

type KimiAuth = z.infer<typeof KimiAuthSchema>;
type KimiTokenRefresh = z.infer<typeof KimiTokenRefreshSchema>;

interface KimiCredentialRecord {
  credentials: KimiAuth & { access_token: string };
  filePath: string | null;
}

interface SaveRefreshedCredentialsOptions {
  filePath: string;
  refreshTokenUsed: string;
  refreshed: KimiTokenRefresh;
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

    const res = await this.fetchUsageResponse(credentials);

    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Kimi usage fetch failed");
      return unavailableUsage(this);
    }

    const windows = kimiUsageWindowsFromPayload(await res.json(), this.logger);

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

  private async fetchUsageResponse(record: KimiCredentialRecord): Promise<Response> {
    const { credentials, filePath } = record;
    const res = await this.callUsageApi(credentials.access_token);

    if (res.status !== 401 || !filePath || !credentials.refresh_token) return res;

    const latest = await this.readCredentialFile(filePath);
    const retried =
      latest?.access_token && latest.access_token !== credentials.access_token
        ? await this.callUsageApi(latest.access_token)
        : res;
    if (retried.status !== 401) return retried;

    const refreshTokenUsed = latest?.refresh_token ?? credentials.refresh_token;
    const refreshed = await this.refreshToken(refreshTokenUsed);
    if (!refreshed) return retried;

    await this.saveRefreshedCredentials({ filePath, refreshTokenUsed, refreshed });
    return this.callUsageApi(refreshed.access_token);
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

  private async saveRefreshedCredentials(options: SaveRefreshedCredentialsOptions): Promise<void> {
    const { filePath, refreshTokenUsed, refreshed } = options;
    const existing = await this.readCredentialFile(filePath);
    if (!existing) return;

    // The Kimi CLI owns this file too. If its refresh token no longer matches the one we
    // just spent, the CLI rotated the credentials while our refresh was in flight and its
    // copy is newer than ours — writing our merge would strand the CLI on dead tokens.
    if (existing.refresh_token !== refreshTokenUsed) {
      this.logger.debug("Kimi credentials rotated during refresh; keeping the file on disk");
      return;
    }

    const expiresIn = refreshed.expires_in ?? existing.expires_in;
    const merged: KimiAuth = {
      ...existing,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token ?? existing.refresh_token,
      expires_in: expiresIn,
      expires_at:
        expiresIn == null ? existing.expires_at : Math.floor(Date.now() / 1000) + expiresIn,
      scope: refreshed.scope ?? existing.scope,
      token_type: refreshed.token_type ?? existing.token_type,
    };

    const tempPath = join(
      dirname(filePath),
      `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await fs.writeFile(tempPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
      await fs.rename(tempPath, filePath);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to persist refreshed Kimi credentials");
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
