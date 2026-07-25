import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageResetCredit,
  ProviderUsageWindow,
} from "../../../server/messages.js";
import type {
  ProviderApiFetch,
  ProviderUsageFetcher,
  ProviderUsageResetQuotaResult,
} from "../provider.js";
import {
  ApiNumberSchema,
  balanceToneFromRemaining,
  fetchProviderApi,
  toneFromUsedPct,
  unavailableUsage,
  windowFromUsedPct,
} from "../usage.js";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_RESET_CREDITS_TIMEOUT_MS = 2_000;

const CodexAuthSchema = z.object({
  tokens: z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().optional(),
      account_id: z.string().optional(),
    })
    .optional(),
});

const CodexWindowSchema = z.object({
  used_percent: ApiNumberSchema.optional(),
  reset_at: ApiNumberSchema.optional(),
});

const CodexRateLimitSchema = z.object({
  primary_window: CodexWindowSchema.nullish(),
  secondary_window: CodexWindowSchema.nullish(),
});

const CodexAdditionalRateLimitSchema = z.object({
  limit_name: z.string().optional(),
  metered_feature: z.string().optional(),
  rate_limit: CodexRateLimitSchema.nullish(),
});

const CodexUsageResponseSchema = z.object({
  plan_type: z.string().optional(),
  email: z.string().optional(),
  rate_limit: CodexRateLimitSchema.nullish(),
  code_review_rate_limit: z
    .object({
      primary_window: CodexWindowSchema.nullish(),
    })
    .nullish(),
  additional_rate_limits: z.array(CodexAdditionalRateLimitSchema).optional(),
  credits: z
    .object({
      has_credits: z.boolean().optional(),
      unlimited: z.boolean().optional(),
      balance: ApiNumberSchema.optional(),
    })
    .nullish(),
  rate_limit_reset_credits: z
    .object({
      available_count: ApiNumberSchema.optional(),
    })
    .nullish(),
});

const CodexResetCreditsResponseSchema = z.object({
  credits: z
    .array(
      z.object({
        id: z.string().optional(),
        reset_type: z.string().optional(),
        status: z.string().optional(),
        granted_at: z.string().nullable().optional(),
        expires_at: z.string().nullable().optional(),
        title: z.string().optional(),
      }),
    )
    .optional(),
  available_count: ApiNumberSchema.optional(),
});

const CodexResetQuotaResponseSchema = z.object({
  code: z.string().optional(),
  windows_reset: ApiNumberSchema.optional(),
});

const CodexTokenRefreshSchema = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
});

type CodexAuth = z.infer<typeof CodexAuthSchema>;
type CodexWindow = z.infer<typeof CodexWindowSchema>;
type CodexAdditionalRateLimit = z.infer<typeof CodexAdditionalRateLimitSchema>;
type CodexUsageResponse = z.infer<typeof CodexUsageResponseSchema>;
type CodexResetCreditsResponse = z.infer<typeof CodexResetCreditsResponseSchema>;
type CodexResetQuotaResponse = z.infer<typeof CodexResetQuotaResponseSchema>;
type CodexTokenRefresh = z.infer<typeof CodexTokenRefreshSchema>;

interface CodexAuthRecord {
  auth: CodexAuth;
  path: string;
}

interface CodexQuotaProviderOptions {
  logger: Logger;
  codexHome?: string;
  fetch?: ProviderApiFetch;
  resetCreditsTimeoutMs?: number;
}

function codexWindow(
  window: CodexWindow | null | undefined,
): { usedPct: number; resetsAt: string | null } | null {
  if (!window) return null;
  return {
    usedPct: window.used_percent ?? 0,
    resetsAt: window.reset_at != null ? new Date(window.reset_at * 1000).toISOString() : null,
  };
}

function codexHeaders(token: string, accountId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  };
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  return headers;
}

function limitId(input: { limitName: string; meteredFeature?: string }): string {
  const raw = input.meteredFeature || input.limitName;
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function limitLabel(limitName: string): string {
  return limitName.replace(/-/g, " ");
}

function codexPrimaryWindows(resp: CodexUsageResponse): ProviderUsageWindow[] {
  const session = codexWindow(resp.rate_limit?.primary_window);
  const weekly = codexWindow(resp.rate_limit?.secondary_window);
  const codeReview = codexWindow(resp.code_review_rate_limit?.primary_window);
  const windows: ProviderUsageWindow[] = [];

  if (session) {
    windows.push(
      windowFromUsedPct({
        id: "session",
        label: "Session",
        utilizationPct: session.usedPct,
        resetsAt: session.resetsAt,
        tone: toneFromUsedPct(session.usedPct),
      }),
    );
  }
  if (weekly) {
    windows.push(
      windowFromUsedPct({
        id: "weekly",
        label: "Weekly",
        utilizationPct: weekly.usedPct,
        resetsAt: weekly.resetsAt,
        tone: toneFromUsedPct(weekly.usedPct),
      }),
    );
  }
  if (codeReview) {
    windows.push(
      windowFromUsedPct({
        id: "code_review",
        label: "Code review",
        utilizationPct: codeReview.usedPct,
        resetsAt: codeReview.resetsAt,
        tone: toneFromUsedPct(codeReview.usedPct),
      }),
    );
  }

  return windows;
}

function codexAdditionalWindows(
  additionalLimits: CodexAdditionalRateLimit[] | undefined,
): ProviderUsageWindow[] {
  const windows: ProviderUsageWindow[] = [];
  for (const additional of additionalLimits ?? []) {
    const limitName = additional.limit_name?.trim();
    if (!limitName) continue;
    const id = limitId({ limitName, meteredFeature: additional.metered_feature });
    const label = limitLabel(limitName);
    const primary = codexWindow(additional.rate_limit?.primary_window);
    const secondary = codexWindow(additional.rate_limit?.secondary_window);
    if (primary) {
      windows.push(
        windowFromUsedPct({
          id: `${id}_five_hour`,
          label: `${label} 5 hour`,
          utilizationPct: primary.usedPct,
          resetsAt: primary.resetsAt,
          tone: toneFromUsedPct(primary.usedPct),
        }),
      );
    }
    if (secondary) {
      windows.push(
        windowFromUsedPct({
          id: `${id}_weekly`,
          label: `${label} weekly`,
          utilizationPct: secondary.usedPct,
          resetsAt: secondary.resetsAt,
          tone: toneFromUsedPct(secondary.usedPct),
        }),
      );
    }
  }
  return windows;
}

function codexBalances(input: {
  resp: CodexUsageResponse;
  resetCredits: ProviderUsageResetCredit[];
  resetCreditsResponse: CodexResetCreditsResponse | null;
}): ProviderUsageBalance[] {
  const balances: ProviderUsageBalance[] = [];
  if (input.resp.credits?.balance !== undefined) {
    balances.push({
      id: "credits",
      label: "Credits",
      remaining: input.resp.credits.balance,
      unit: "usd",
      tone: balanceToneFromRemaining(input.resp.credits.balance),
    });
  }

  const resetCreditCount =
    input.resetCreditsResponse?.available_count ??
    input.resp.rate_limit_reset_credits?.available_count ??
    null;
  if (input.resetCredits.length === 0 && resetCreditCount != null && resetCreditCount > 0) {
    balances.push({
      id: "rate_limit_reset_credits",
      label: "Banked resets",
      remaining: resetCreditCount,
      unit: "requests",
      tone: "ok",
    });
  }

  return balances;
}

function resetQuotaMessage(code: string, windowsReset: number | null): string {
  switch (code) {
    case "reset":
      return windowsReset && windowsReset > 0
        ? `Reset quota consumed. Windows reset: ${windowsReset}.`
        : "Reset quota consumed.";
    case "nothing_to_reset":
      return "No reset was consumed because there is nothing to reset.";
    case "no_credit":
      return "No reset was consumed because no reset credits are available.";
    case "already_redeemed":
      return "This reset request was already redeemed.";
    default:
      return `Codex returned reset result: ${code}.`;
  }
}

export class CodexQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "codex";
  readonly displayName = "Codex";

  private readonly logger: Logger;
  private readonly codexHome: string;
  private readonly fetchApi: ProviderApiFetch;
  private readonly resetCreditsTimeoutMs: number;

  constructor(options: CodexQuotaProviderOptions) {
    this.logger = options.logger.child({ module: "codex-quota-provider" });
    this.codexHome = options.codexHome || process.env["CODEX_HOME"] || join(homedir(), ".codex");
    this.fetchApi = options.fetch ?? fetch;
    this.resetCreditsTimeoutMs = options.resetCreditsTimeoutMs ?? CODEX_RESET_CREDITS_TIMEOUT_MS;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const authRecord = await this.readCodexAuth();
    const auth = authRecord?.auth;
    const accessToken = auth?.tokens?.access_token;
    if (!authRecord || !auth || !accessToken) {
      return unavailableUsage(this);
    }

    const { refresh_token, account_id } = auth.tokens ?? {};
    let currentAccessToken = accessToken;
    let resp = await this.callCodexApi(currentAccessToken, account_id);

    if (resp === "NEEDS_AUTH") {
      if (!refresh_token) {
        return unavailableUsage(this);
      }
      const refreshed = await this.refreshCodexToken(refresh_token);
      if (!refreshed?.access_token) {
        return unavailableUsage(this);
      }

      await this.saveCodexAuth(authRecord.path, auth, refreshed);
      currentAccessToken = refreshed.access_token;
      resp = await this.callCodexApi(currentAccessToken, account_id);
      if (resp === "NEEDS_AUTH") {
        return unavailableUsage(this);
      }
    }

    const resetCredits = await this.tryFetchResetCredits(currentAccessToken, account_id);
    return this.toUsage(resp, resetCredits);
  }

  async resetQuota(): Promise<ProviderUsageResetQuotaResult> {
    const authRecord = await this.readCodexAuth();
    const auth = authRecord?.auth;
    const accessToken = auth?.tokens?.access_token;
    if (!authRecord || !auth || !accessToken) {
      throw new Error("Codex auth is unavailable");
    }

    const { refresh_token, account_id } = auth.tokens ?? {};
    let resp = await this.callResetQuotaApi(accessToken, account_id);

    if (resp === "NEEDS_AUTH") {
      if (!refresh_token) {
        throw new Error("Codex auth expired");
      }
      const refreshed = await this.refreshCodexToken(refresh_token);
      if (!refreshed?.access_token) {
        throw new Error("Unable to refresh Codex auth");
      }

      await this.saveCodexAuth(authRecord.path, auth, refreshed);
      resp = await this.callResetQuotaApi(refreshed.access_token, account_id);
      if (resp === "NEEDS_AUTH") {
        throw new Error("Codex auth expired");
      }
    }

    const code = resp.code ?? "unknown";
    const windowsReset = resp.windows_reset ?? null;
    return {
      providerId: this.providerId,
      code,
      windowsReset,
      message: resetQuotaMessage(code, windowsReset),
    };
  }

  private toUsage(
    resp: CodexUsageResponse,
    resetCreditsResponse: CodexResetCreditsResponse | null,
  ): ProviderUsage {
    const windows = [
      ...codexPrimaryWindows(resp),
      ...codexAdditionalWindows(resp.additional_rate_limits),
    ];
    const resetCredits = this.toResetCredits(resetCreditsResponse);
    const balances = codexBalances({ resp, resetCredits, resetCreditsResponse });

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: resp.plan_type ?? null,
      windows,
      balances,
      details: [],
      resetCredits,
      error: null,
    };
  }

  private toResetCredits(response: CodexResetCreditsResponse | null): ProviderUsageResetCredit[] {
    const credits = response?.credits ?? [];
    return credits
      .filter((credit) => credit.status?.toLowerCase() === "available")
      .sort((a, b) => {
        const left = a.expires_at ? new Date(a.expires_at).getTime() : Number.POSITIVE_INFINITY;
        const right = b.expires_at ? new Date(b.expires_at).getTime() : Number.POSITIVE_INFINITY;
        return left - right;
      })
      .map((credit, index) => ({
        id: credit.id ?? `codex_reset_credit_${index + 1}`,
        label: credit.title?.trim() || `Reset ${index + 1}`,
        status: "available",
        grantedAt: credit.granted_at ?? null,
        expiresAt: credit.expires_at ?? null,
        tone: "ok",
      }));
  }

  private async readCodexAuth(): Promise<CodexAuthRecord | null> {
    const candidates = [
      ...(process.env["CODEX_HOME"] ? [join(process.env["CODEX_HOME"], "auth.json")] : []),
      join(homedir(), ".config", "codex", "auth.json"),
      join(this.codexHome, "auth.json"),
    ];
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      try {
        const auth = CodexAuthSchema.parse(JSON.parse(await fs.readFile(path, "utf8")));
        if (auth.tokens?.access_token) return { auth, path };
      } catch {
        continue;
      }
    }
    return null;
  }

  private async callCodexApi(
    token: string,
    accountId?: string,
  ): Promise<CodexUsageResponse | "NEEDS_AUTH"> {
    const res = await fetchProviderApi(
      this.fetchApi,
      "https://chatgpt.com/backend-api/wham/usage",
      {
        headers: codexHeaders(token, accountId),
      },
    );
    if (res.status === 401 || res.status === 403) return "NEEDS_AUTH";
    if (!res.ok) throw new Error(`Codex usage API returned ${res.status}`);
    const text = await res.text();
    if (text.trim().startsWith("<")) return "NEEDS_AUTH";
    return CodexUsageResponseSchema.parse(JSON.parse(text));
  }

  private async tryFetchResetCredits(
    token: string,
    accountId?: string,
  ): Promise<CodexResetCreditsResponse | null> {
    try {
      const headers = {
        ...codexHeaders(token, accountId),
        originator: "Codex Desktop",
        "OAI-Product-Sku": "CODEX",
      };
      const res = await fetchProviderApi(
        this.fetchApi,
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
        {
          headers,
          signal: AbortSignal.timeout(this.resetCreditsTimeoutMs),
        },
      );
      if (!res.ok) return null;
      const text = await res.text();
      if (text.trim().startsWith("<")) return null;
      return CodexResetCreditsResponseSchema.parse(JSON.parse(text));
    } catch (err) {
      this.logger.debug({ err }, "Failed to fetch Codex reset credits");
      return null;
    }
  }

  private async callResetQuotaApi(
    token: string,
    accountId?: string,
  ): Promise<CodexResetQuotaResponse | "NEEDS_AUTH"> {
    const headers = {
      ...codexHeaders(token, accountId),
      "Content-Type": "application/json",
      originator: "Codex Desktop",
      "OAI-Product-Sku": "CODEX",
    };
    const res = await fetchProviderApi(
      this.fetchApi,
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ redeem_request_id: randomUUID() }),
      },
    );
    if (res.status === 401 || res.status === 403) return "NEEDS_AUTH";
    if (!res.ok) throw new Error(`Codex reset quota API returned ${res.status}`);
    const text = await res.text();
    if (text.trim().startsWith("<")) return "NEEDS_AUTH";
    return CodexResetQuotaResponseSchema.parse(JSON.parse(text));
  }

  private async refreshCodexToken(refreshToken: string): Promise<CodexTokenRefresh | null> {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CODEX_CLIENT_ID,
      refresh_token: refreshToken,
    });
    const res = await fetchProviderApi(this.fetchApi, "https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!res.ok) return null;
    return CodexTokenRefreshSchema.parse(await res.json());
  }

  private async saveCodexAuth(
    authPath: string,
    original: CodexAuth,
    refreshed: CodexTokenRefresh,
  ): Promise<void> {
    try {
      const updated: CodexAuth = {
        ...original,
        tokens: {
          ...original.tokens,
          access_token: refreshed.access_token ?? original.tokens?.access_token,
          refresh_token: refreshed.refresh_token ?? original.tokens?.refresh_token,
        },
      };
      await fs.writeFile(authPath, JSON.stringify(updated, null, 2), { mode: 0o600 });
    } catch {
      // Non-fatal; the next call can refresh again.
    }
  }
}
