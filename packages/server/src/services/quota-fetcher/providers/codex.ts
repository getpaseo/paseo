import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageWindow,
} from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNullableNumberSchema,
  ApiNumberSchema,
  balanceToneFromRemaining,
  toneFromUsedPct,
  fetchProviderApi,
  unavailableUsage,
  usedPctOf,
  windowFromUsedPct,
} from "../usage.js";

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

// ChatGPT Business/Enterprise plans rate-limit individual metered features
// (e.g. codex_bengalfox) in this array instead of the top-level rate_limit.
const CodexAdditionalRateLimitSchema = z.object({
  limit_name: z.string().optional(),
  metered_feature: z.string().optional(),
  rate_limit: z
    .object({
      allowed: z.boolean().optional(),
      limit_reached: z.boolean().optional(),
      primary_window: CodexWindowSchema.nullish(),
      secondary_window: CodexWindowSchema.nullish(),
    })
    .nullish(),
});

// ChatGPT Business/Enterprise spend-control budget. Business plans quote a
// monthly credit cap here (e.g. limit: "32500") with used/remaining as strings.
const CodexSpendLimitSchema = z.object({
  source: z.string().optional(),
  limit: ApiNullableNumberSchema.optional(),
  used: ApiNullableNumberSchema.optional(),
  remaining: ApiNullableNumberSchema.optional(),
  used_percent: ApiNullableNumberSchema.optional(),
  remaining_percent: ApiNullableNumberSchema.optional(),
  reset_after_seconds: ApiNullableNumberSchema.optional(),
  reset_at: ApiNullableNumberSchema.optional(),
});

const CodexUsageResponseSchema = z.object({
  plan_type: z.string().optional(),
  email: z.string().optional(),
  rate_limit: z
    .object({
      primary_window: CodexWindowSchema.nullish(),
      secondary_window: CodexWindowSchema.nullish(),
    })
    .nullish(),
  code_review_rate_limit: z
    .object({
      primary_window: CodexWindowSchema.nullish(),
    })
    .nullish(),
  additional_rate_limits: z.array(CodexAdditionalRateLimitSchema).nullish(),
  spend_control: z
    .object({
      reached: z.boolean().optional(),
      individual_limit: CodexSpendLimitSchema.nullish(),
    })
    .nullish(),
  credits: z
    .object({
      has_credits: z.boolean().optional(),
      unlimited: z.boolean().optional(),
      balance: ApiNullableNumberSchema.optional(),
    })
    .nullish(),
});

type CodexAuth = z.infer<typeof CodexAuthSchema>;
type CodexWindow = z.infer<typeof CodexWindowSchema>;
type CodexUsageResponse = z.infer<typeof CodexUsageResponseSchema>;

interface CodexQuotaProviderOptions {
  logger: Logger;
  codexHome?: string;
  fetch?: ProviderApiFetch;
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

export class CodexQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "codex";
  readonly displayName = "Codex";

  private readonly codexHome: string;
  private readonly fetchApi: ProviderApiFetch;

  constructor(options: CodexQuotaProviderOptions) {
    this.codexHome = options.codexHome || process.env["CODEX_HOME"] || join(homedir(), ".codex");
    this.fetchApi = options.fetch ?? fetch;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const auth = await this.readCodexAuth();
    const accessToken = auth?.tokens?.access_token;
    if (!auth || !accessToken) {
      return unavailableUsage(this);
    }

    const { account_id } = auth.tokens ?? {};
    const resp = await this.callCodexApi(accessToken, account_id);

    if (resp === "NEEDS_AUTH") {
      // Read-only on credentials; the Codex CLI owns refresh. See docs/providers.md.
      return unavailableUsage(this);
    }

    return this.toUsage(resp);
  }

  private toUsage(resp: CodexUsageResponse): ProviderUsage {
    const windows: ProviderUsageWindow[] = [];
    this.pushWindow({
      windows,
      id: "session",
      label: "Session",
      window: codexWindow(resp.rate_limit?.primary_window),
    });
    this.pushWindow({
      windows,
      id: "weekly",
      label: "Weekly",
      window: codexWindow(resp.rate_limit?.secondary_window),
    });
    this.pushWindow({
      windows,
      id: "code_review",
      label: "Code review",
      window: codexWindow(resp.code_review_rate_limit?.primary_window),
    });

    // ChatGPT Business/Enterprise omit the top-level rate_limit entirely and
    // rate-limit each metered feature (e.g. codex_bengalfox) instead. Without
    // this, a business account renders with no windows at all. Keyed on the
    // absent top-level limit rather than `windows.length === 0` so an
    // independent code_review_rate_limit cannot suppress these windows.
    if (resp.rate_limit == null && resp.additional_rate_limits?.length) {
      windows.push(...this.additionalRateLimitWindows(resp.additional_rate_limits));
    }

    const balances: ProviderUsageBalance[] = [];

    // Business/Enterprise plans meter spend-control credits (monthly cap, reset
    // on the calendar period) rather than a per-account credit balance.
    const spendLimit = resp.spend_control?.individual_limit;
    if (spendLimit?.limit != null) {
      const usedPct = spendLimit.used_percent ?? usedPctOf(spendLimit.used, spendLimit.limit) ?? 0;
      balances.push({
        id: "spend",
        label: "Spend",
        used: spendLimit.used ?? null,
        remaining: spendLimit.remaining ?? null,
        limit: spendLimit.limit,
        unit: "credits",
        resetsAt:
          spendLimit.reset_at != null ? new Date(spendLimit.reset_at * 1000).toISOString() : null,
        tone: toneFromUsedPct(usedPct),
      });
    } else if (resp.credits?.balance != null) {
      balances.push({
        id: "credits",
        label: "Credits",
        remaining: resp.credits.balance,
        unit: "usd",
        tone: balanceToneFromRemaining(resp.credits.balance),
      });
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: resp.plan_type ?? null,
      windows,
      balances,
      details: [],
      error: null,
    };
  }

  /**
   * Append one window built from a parsed API window, when present.
   */
  private pushWindow(input: {
    windows: ProviderUsageWindow[];
    id: string;
    label: string;
    window: { usedPct: number; resetsAt: string | null } | null;
  }): void {
    if (!input.window) return;
    input.windows.push(
      windowFromUsedPct({
        id: input.id,
        label: input.label,
        utilizationPct: input.window.usedPct,
        resetsAt: input.window.resetsAt,
        tone: toneFromUsedPct(input.window.usedPct),
      }),
    );
  }

  /**
   * Per-feature rate-limit windows for ChatGPT Business/Enterprise accounts,
   * which omit the top-level rate_limit block entirely.
   */
  private additionalRateLimitWindows(
    limits: NonNullable<CodexUsageResponse["additional_rate_limits"]>,
  ): ProviderUsageWindow[] {
    const windows: ProviderUsageWindow[] = [];
    for (const [index, feature] of limits.entries()) {
      const featureName = feature.limit_name || feature.metered_feature || `Feature ${index + 1}`;
      const featureSession = codexWindow(feature.rate_limit?.primary_window);
      const featureWeekly = codexWindow(feature.rate_limit?.secondary_window);
      if (featureSession) {
        windows.push(
          windowFromUsedPct({
            id: `session_${index}`,
            label: `Session · ${featureName}`,
            utilizationPct: featureSession.usedPct,
            resetsAt: featureSession.resetsAt,
            tone: toneFromUsedPct(featureSession.usedPct),
          }),
        );
      }
      if (featureWeekly) {
        windows.push(
          windowFromUsedPct({
            id: `weekly_${index}`,
            label: `Weekly · ${featureName}`,
            utilizationPct: featureWeekly.usedPct,
            resetsAt: featureWeekly.resetsAt,
            tone: toneFromUsedPct(featureWeekly.usedPct),
          }),
        );
      }
    }
    return windows;
  }

  private async readCodexAuth(): Promise<CodexAuth | null> {
    const candidates = [
      ...(process.env["CODEX_HOME"] ? [join(process.env["CODEX_HOME"], "auth.json")] : []),
      join(homedir(), ".config", "codex", "auth.json"),
      join(this.codexHome, "auth.json"),
    ];
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      try {
        const auth = CodexAuthSchema.parse(JSON.parse(await fs.readFile(path, "utf8")));
        if (auth.tokens?.access_token) return auth;
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
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    };
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;

    const res = await fetchProviderApi(
      this.fetchApi,
      "https://chatgpt.com/backend-api/wham/usage",
      {
        headers,
      },
    );
    if (res.status === 401 || res.status === 403) return "NEEDS_AUTH";
    if (!res.ok) throw new Error(`Codex usage API returned ${res.status}`);
    const text = await res.text();
    if (text.trim().startsWith("<")) return "NEEDS_AUTH";
    return CodexUsageResponseSchema.parse(JSON.parse(text));
  }
}
