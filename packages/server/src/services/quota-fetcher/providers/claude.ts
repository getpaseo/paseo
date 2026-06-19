import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
  unavailableUsage,
  windowFromUsedPct,
} from "../usage.js";

const execFileAsync = promisify(execFile);
const CLAUDE_KEYCHAIN_TIMEOUT_MS = 2_000;
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

const ClaudeCredentialsSchema = z.object({
  claudeAiOauth: z
    .object({
      accessToken: z.string().optional(),
      refreshToken: z.string().optional(),
      subscriptionType: z.string().optional(),
      rateLimitTier: z.string().optional(),
    })
    .optional(),
});

const ClaudeUsageWindowSchema = z.object({
  utilization: ApiNumberSchema,
  resets_at: z.string().optional(),
});

const ClaudeUsageResponseSchema = z.object({
  five_hour: ClaudeUsageWindowSchema.nullish(),
  seven_day: ClaudeUsageWindowSchema.nullish(),
  seven_day_opus: ClaudeUsageWindowSchema.nullish(),
  seven_day_omelette: ClaudeUsageWindowSchema.nullish(),
  extra_usage: z
    .object({
      is_enabled: z.boolean().optional(),
    })
    .nullish(),
});

const ClaudeTokenRefreshSchema = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
});

type ClaudeCredentials = z.infer<typeof ClaudeCredentialsSchema>;
type ClaudeUsageResponse = z.infer<typeof ClaudeUsageResponseSchema>;
type ClaudeTokenRefresh = z.infer<typeof ClaudeTokenRefreshSchema>;

interface ClaudeCredentialRecord {
  oauth: { accessToken: string } & NonNullable<ClaudeCredentials["claudeAiOauth"]>;
  filePath: string | null;
}

interface ClaudeQuotaProviderOptions {
  logger: Logger;
  claudeHome?: string;
  claudeKeychainReader?: () => Promise<unknown | null>;
  platform?: typeof process.platform;
  fetch?: ProviderApiFetch;
}

function buildClaudePlan(
  subscriptionType: string | undefined,
  rateLimitTier: string | undefined,
): string | null {
  if (!subscriptionType) return null;
  const label = subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
  const tier = rateLimitTier?.split("_").pop();
  return tier ? `${label} ${tier}` : label;
}

async function readClaudeKeychainCredentials(): Promise<unknown | null> {
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
      { timeout: CLAUDE_KEYCHAIN_TIMEOUT_MS },
    );
    const raw = stdout.trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export class ClaudeQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "claude";
  readonly displayName = "Claude";

  private readonly claudeHome: string;
  private readonly readKeychainCredentials: () => Promise<unknown | null>;
  private readonly platform: typeof process.platform;
  private readonly fetchApi: ProviderApiFetch;

  constructor(options: ClaudeQuotaProviderOptions) {
    this.claudeHome =
      options.claudeHome || process.env["CLAUDE_HOME"] || join(homedir(), ".claude");
    this.readKeychainCredentials = options.claudeKeychainReader ?? readClaudeKeychainCredentials;
    this.platform = options.platform ?? process.platform;
    this.fetchApi = options.fetch ?? fetch;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const credentials = await this.readCredentials();
    if (!credentials) {
      return unavailableUsage(this);
    }

    const { oauth, filePath } = credentials;
    const plan = buildClaudePlan(oauth.subscriptionType, oauth.rateLimitTier);
    let resp = await this.callClaudeApi(oauth.accessToken);

    if (resp === "NEEDS_AUTH") {
      if (!filePath || !oauth.refreshToken) {
        return unavailableUsage(this);
      }

      const refreshed = await this.refreshClaudeToken(oauth.refreshToken);
      if (!refreshed?.access_token) {
        return unavailableUsage(this);
      }

      await this.saveClaudeCredentials(filePath, {
        ...oauth,
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token ?? oauth.refreshToken,
      });

      resp = await this.callClaudeApi(refreshed.access_token);
      if (resp === "NEEDS_AUTH") {
        return unavailableUsage(this);
      }
    }

    const windows: ProviderUsageWindow[] = [];
    if (resp.five_hour) {
      windows.push(
        windowFromUsedPct({
          id: "five_hour",
          label: "Session",
          utilizationPct: resp.five_hour.utilization,
          resetsAt: resp.five_hour.resets_at ?? null,
          tone: "ok",
        }),
      );
    }
    if (resp.seven_day) {
      windows.push(
        windowFromUsedPct({
          id: "weekly",
          label: "Weekly",
          utilizationPct: resp.seven_day.utilization,
          resetsAt: resp.seven_day.resets_at ?? null,
          tone: "ok",
        }),
      );
    }
    if (resp.seven_day_opus) {
      windows.push(
        windowFromUsedPct({
          id: "weekly_opus",
          label: "Weekly · Opus",
          utilizationPct: resp.seven_day_opus.utilization,
          resetsAt: resp.seven_day_opus.resets_at ?? null,
          tone: "ok",
        }),
      );
    }
    if (resp.seven_day_omelette) {
      windows.push(
        windowFromUsedPct({
          id: "weekly_omelette",
          label: "Weekly · Omelette",
          utilizationPct: resp.seven_day_omelette.utilization,
          resetsAt: resp.seven_day_omelette.resets_at ?? null,
          tone: "ok",
        }),
      );
    }

    const details: ProviderUsageDetail[] = [];
    const extraUsageEnabled = resp.extra_usage?.is_enabled;
    if (extraUsageEnabled !== undefined) {
      details.push({
        id: "extra_usage",
        label: "Extra usage",
        value: extraUsageEnabled ? "Enabled" : "Disabled",
      });
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: plan,
      windows,
      balances: [],
      details,
      error: null,
    };
  }

  private async readCredentials(): Promise<ClaudeCredentialRecord | null> {
    const credPath = join(this.claudeHome, ".credentials.json");

    if (existsSync(credPath)) {
      try {
        const creds = ClaudeCredentialsSchema.parse(
          JSON.parse(await fs.readFile(credPath, "utf8")),
        );
        const oauth = creds.claudeAiOauth;
        if (oauth?.accessToken) {
          return { oauth: { ...oauth, accessToken: oauth.accessToken }, filePath: credPath };
        }
      } catch {
        // Fall through to the macOS Keychain below.
      }
    }

    if (this.platform === "darwin") {
      const creds = ClaudeCredentialsSchema.safeParse(await this.readKeychainCredentials());
      const oauth = creds.success ? creds.data.claudeAiOauth : undefined;
      if (oauth?.accessToken) {
        return { oauth: { ...oauth, accessToken: oauth.accessToken }, filePath: null };
      }
    }

    return null;
  }

  private async callClaudeApi(token: string): Promise<ClaudeUsageResponse | "NEEDS_AUTH"> {
    const res = await fetchProviderApi(this.fetchApi, "https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "anthropic-beta": CLAUDE_OAUTH_BETA,
      },
    });
    if (res.status === 401 || res.status === 403) return "NEEDS_AUTH";
    if (!res.ok) throw new Error(`Claude usage API returned ${res.status}`);
    return ClaudeUsageResponseSchema.parse(await res.json());
  }

  private async refreshClaudeToken(refreshToken: string): Promise<ClaudeTokenRefresh | null> {
    const res = await fetchProviderApi(
      this.fetchApi,
      "https://platform.claude.com/v1/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: CLAUDE_CLIENT_ID,
          scope: "user:profile user:inference user:sessions:claude_code user:mcp_servers",
        }),
      },
    );
    if (!res.ok) return null;
    return ClaudeTokenRefreshSchema.parse(await res.json());
  }

  private async saveClaudeCredentials(
    credPath: string,
    oauth: ClaudeCredentials["claudeAiOauth"],
  ): Promise<void> {
    try {
      const existing = ClaudeCredentialsSchema.parse(
        JSON.parse(await fs.readFile(credPath, "utf8")),
      );
      existing.claudeAiOauth = oauth;
      await fs.writeFile(credPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
    } catch {
      // Non-fatal; Claude Code can refresh again on its own next time.
    }
  }
}
