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
  ApiNumberSchema,
  balanceToneFromRemaining,
  toneFromUsedPct,
  fetchProviderApi,
  unavailableUsage,
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
  credits: z
    .object({
      has_credits: z.boolean().optional(),
      unlimited: z.boolean().optional(),
      balance: ApiNumberSchema.optional(),
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

    const balances: ProviderUsageBalance[] = [];
    if (resp.credits?.balance !== undefined) {
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
