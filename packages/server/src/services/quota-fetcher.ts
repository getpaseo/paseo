/**
 * Provider usage fetchers
 *
 * Fetches plan quota utilization from Anthropic, OpenAI, GitHub Copilot, Cursor,
 * Z.ai, Grok, and Kimi provider APIs. ProviderUsageService exposes the
 * fetch-on-demand RPC path; QuotaFetcherService remains only for the legacy
 * `provider_quota` message contract.
 */

import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "pino";
import { z } from "zod";
import type {
  ProviderQuotaMessage,
  ProviderQuotaWindow,
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageDetail,
  ProviderUsageWindow,
} from "../server/messages.js";

const execFileAsync = promisify(execFile);
const CURSOR_SQLITE_TIMEOUT_MS = 2_000;
const CLAUDE_KEYCHAIN_TIMEOUT_MS = 2_000;

const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// macOS: Claude Code stores its OAuth credential in the login Keychain under
// this generic-password service name instead of ~/.claude/.credentials.json.
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const ApiNumberSchema = z.coerce.number().finite();

export interface QuotaFetcherServiceOptions {
  broadcast: (message: ProviderQuotaMessage) => void;
  logger: Logger;
  claudeHome?: string;
  claudeKeychainReader?: () => Promise<ClaudeCredentials | null>;
  codexHome?: string;
  pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Provider Interface
// ---------------------------------------------------------------------------
export interface QuotaProvider {
  readonly id: string;
  fetch(): Promise<unknown>;
}

export interface ProviderUsageFetcher {
  readonly providerId: string;
  readonly displayName: string;
  fetchUsage(): Promise<ProviderUsage>;
}

export interface ProviderUsageFetcherFactoryOptions {
  logger: Logger;
  claudeHome?: string;
  claudeKeychainReader?: () => Promise<ClaudeCredentials | null>;
  codexHome?: string;
}

export interface ProviderUsageFetcherManifestEntry {
  readonly providerId: string;
  create(options: ProviderUsageFetcherFactoryOptions): ProviderUsageFetcher;
}

function unavailableUsage(provider: {
  providerId: string;
  displayName: string;
  error?: string | null;
}): ProviderUsage {
  return {
    providerId: provider.providerId,
    displayName: provider.displayName,
    status: provider.error ? "error" : "unavailable",
    planLabel: null,
    windows: [],
    balances: [],
    details: [],
    error: provider.error ?? null,
  };
}

function windowFromUsedPct(input: {
  id: string;
  label: string;
  utilizationPct: number | null | undefined;
  resetsAt?: string | null;
  tone?: ProviderUsageWindow["tone"];
}): ProviderUsageWindow {
  const usedPct = typeof input.utilizationPct === "number" ? input.utilizationPct : null;
  const window: ProviderUsageWindow = {
    id: input.id,
    label: input.label,
    usedPct,
    remainingPct: usedPct === null ? null : Math.max(0, 100 - usedPct),
    resetsAt: input.resetsAt ?? null,
  };
  if (input.tone) {
    window.tone = input.tone;
  }
  return window;
}

function balanceToneFromRemaining(
  remaining: number | null | undefined,
): ProviderUsageBalance["tone"] {
  if (typeof remaining !== "number") return "default";
  if (remaining <= 0) return "danger";
  return "ok";
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------
interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

interface ClaudeCredentialRecord {
  // accessToken is guaranteed present; the remaining oauth fields stay optional.
  oauth: { accessToken: string } & NonNullable<ClaudeCredentials["claudeAiOauth"]>;
  // Path of the writable file store, or null when the credential was read from
  // the macOS Keychain (read-only there — Claude Code owns refresh/persist).
  filePath: string | null;
}

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

type ClaudeUsageWindow = z.infer<typeof ClaudeUsageWindowSchema>;
type ClaudeUsageResponse = z.infer<typeof ClaudeUsageResponseSchema>;
type ClaudeTokenRefresh = z.infer<typeof ClaudeTokenRefreshSchema>;

function toQuotaWindow(w: ClaudeUsageWindow | null | undefined): ProviderQuotaWindow | null {
  if (!w) return null;
  return { utilizationPct: w.utilization, resetsAt: w.resets_at };
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

// macOS only: Claude Code stores its OAuth credential in the login Keychain as a
// generic-password item, not in ~/.claude/.credentials.json (which usually does
// not exist on macOS). The Keychain item's ACL grants decrypt only to
// /usr/bin/security, so read it by shelling out to the `security` CLI — a native
// Keychain read under our own identity would trigger an interactive
// authorization prompt the daemon cannot answer.
async function readClaudeKeychainCredentials(): Promise<ClaudeCredentials | null> {
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
      { timeout: CLAUDE_KEYCHAIN_TIMEOUT_MS },
    );
    const raw = stdout.trim();
    if (!raw) return null;
    return JSON.parse(raw) as ClaudeCredentials;
  } catch {
    // No Keychain item, non-macOS, or malformed payload.
    return null;
  }
}

export class ClaudeQuotaProvider implements QuotaProvider, ProviderUsageFetcher {
  readonly id = "claude";
  readonly providerId = "claude";
  readonly displayName = "Claude";

  private readonly claudeHome: string;
  private readonly readKeychainCredentials: () => Promise<ClaudeCredentials | null>;

  constructor(
    _logger: Logger,
    claudeHome?: string,
    readKeychainCredentials = readClaudeKeychainCredentials,
  ) {
    this.claudeHome = claudeHome || process.env["CLAUDE_HOME"] || join(homedir(), ".claude");
    this.readKeychainCredentials = readKeychainCredentials;
  }

  async fetch(): Promise<ProviderQuotaMessage["payload"]["claude"]> {
    const credentials = await this.readCredentials();
    if (!credentials) return undefined;

    const { oauth, filePath } = credentials;
    const plan = buildClaudePlan(oauth.subscriptionType, oauth.rateLimitTier);

    let resp = await this.callClaudeApi(oauth.accessToken);

    if (resp === "NEEDS_AUTH") {
      // On macOS the credential lives in the Keychain (filePath === null) whose ACL
      // only trusts /usr/bin/security. Since Claude Code owns the refresh and Anthropic
      // rotates/revokes the refresh token on the server, we must skip token refresh
      // if read-only (Keychain) to avoid invalidating Claude Code's login state.
      if (!filePath) return undefined;

      if (!oauth.refreshToken) return undefined;
      const refreshed = await this.refreshClaudeToken(oauth.refreshToken);
      if (!refreshed?.access_token) return undefined;

      await this.saveClaudeCredentials(filePath, {
        ...oauth,
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token ?? oauth.refreshToken,
      });

      resp = await this.callClaudeApi(refreshed.access_token);
      if (resp === "NEEDS_AUTH") return undefined;
    }

    return {
      fiveHour: toQuotaWindow(resp.five_hour),
      sevenDay: toQuotaWindow(resp.seven_day),
      sevenDayOpus: toQuotaWindow(resp.seven_day_opus),
      sevenDayOmelette: toQuotaWindow(resp.seven_day_omelette),
      extraUsage: resp.extra_usage
        ? {
            isEnabled: resp.extra_usage.is_enabled ?? null,
          }
        : null,
      plan,
    };
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const quota = await this.fetch();
    if (!quota) {
      return unavailableUsage(this);
    }

    const windows: ProviderUsageWindow[] = [];
    if (quota.fiveHour) {
      windows.push(
        windowFromUsedPct({
          id: "five_hour",
          label: "Session",
          utilizationPct: quota.fiveHour.utilizationPct,
          resetsAt: quota.fiveHour.resetsAt ?? null,
          tone: "ok",
        }),
      );
    }
    if (quota.sevenDay) {
      windows.push(
        windowFromUsedPct({
          id: "weekly",
          label: "Weekly",
          utilizationPct: quota.sevenDay.utilizationPct,
          resetsAt: quota.sevenDay.resetsAt ?? null,
          tone: "ok",
        }),
      );
    }
    if (quota.sevenDayOpus) {
      windows.push(
        windowFromUsedPct({
          id: "weekly_opus",
          label: "Weekly · Opus",
          utilizationPct: quota.sevenDayOpus.utilizationPct,
          resetsAt: quota.sevenDayOpus.resetsAt ?? null,
          tone: "ok",
        }),
      );
    }
    if (quota.sevenDayOmelette) {
      windows.push(
        windowFromUsedPct({
          id: "weekly_omelette",
          label: "Weekly · Omelette",
          utilizationPct: quota.sevenDayOmelette.utilizationPct,
          resetsAt: quota.sevenDayOmelette.resetsAt ?? null,
          tone: "ok",
        }),
      );
    }

    const details: ProviderUsageDetail[] = [];
    if (quota.extraUsage?.isEnabled !== undefined && quota.extraUsage?.isEnabled !== null) {
      details.push({
        id: "extra_usage",
        label: "Extra usage",
        value: quota.extraUsage.isEnabled ? "Enabled" : "Disabled",
      });
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: quota.plan,
      windows,
      balances: [],
      details,
      error: null,
    };
  }

  private async readCredentials(): Promise<ClaudeCredentialRecord | null> {
    const credPath = join(this.claudeHome, ".credentials.json");

    // Linux/Windows (and macOS when the file is present) use the file store.
    if (existsSync(credPath)) {
      try {
        const creds: ClaudeCredentials = JSON.parse(await fs.readFile(credPath, "utf8"));
        const oauth = creds.claudeAiOauth;
        if (oauth?.accessToken) {
          return { oauth: { ...oauth, accessToken: oauth.accessToken }, filePath: credPath };
        }
      } catch {
        // Fall through to the macOS Keychain below.
      }
    }

    // macOS keeps the credential in the login Keychain, not the file.
    if (process.platform === "darwin") {
      const creds = await this.readKeychainCredentials();
      const oauth = creds?.claudeAiOauth;
      if (oauth?.accessToken) {
        return { oauth: { ...oauth, accessToken: oauth.accessToken }, filePath: null };
      }
    }

    return null;
  }

  private async callClaudeApi(token: string): Promise<ClaudeUsageResponse | "NEEDS_AUTH"> {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
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
    const res = await fetch("https://platform.claude.com/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLAUDE_CLIENT_ID,
        scope: "user:profile user:inference user:sessions:claude_code user:mcp_servers",
      }),
    });
    if (!res.ok) return null;
    return ClaudeTokenRefreshSchema.parse(await res.json());
  }

  private async saveClaudeCredentials(
    credPath: string,
    oauth: ClaudeCredentials["claudeAiOauth"],
  ): Promise<void> {
    try {
      const existing = JSON.parse(await fs.readFile(credPath, "utf8")) as ClaudeCredentials;
      existing.claudeAiOauth = oauth;
      await fs.writeFile(credPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
    } catch {
      // Non-fatal
    }
  }
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------
interface CodexAuth {
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
}

interface CodexAuthRecord {
  auth: CodexAuth;
  path: string;
}

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

const CodexTokenRefreshSchema = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
});

type CodexWindow = z.infer<typeof CodexWindowSchema>;
type CodexUsageResponse = z.infer<typeof CodexUsageResponseSchema>;
type CodexTokenRefresh = z.infer<typeof CodexTokenRefreshSchema>;

export class CodexQuotaProvider implements QuotaProvider, ProviderUsageFetcher {
  readonly id = "codex";
  readonly providerId = "codex";
  readonly displayName = "Codex";

  private readonly codexHome: string;

  constructor(_logger: Logger, codexHome?: string) {
    this.codexHome = codexHome || process.env["CODEX_HOME"] || join(homedir(), ".codex");
  }

  async fetch(): Promise<ProviderQuotaMessage["payload"]["codex"]> {
    const authRecord = await this.readCodexAuth();
    if (!authRecord) return undefined;

    const auth = authRecord.auth;
    if (!auth?.tokens?.access_token) return undefined;

    const { access_token, refresh_token, account_id } = auth.tokens;

    let resp = await this.callCodexApi(access_token, account_id);

    if (resp === "NEEDS_AUTH") {
      if (!refresh_token) return undefined;
      const refreshed = await this.refreshCodexToken(refresh_token);
      if (!refreshed?.access_token) return undefined;

      await this.saveCodexAuth(authRecord.path, auth, refreshed);
      resp = await this.callCodexApi(refreshed.access_token, account_id);
      if (resp === "NEEDS_AUTH") return undefined;
    }

    const toWindow = (w: CodexWindow | null | undefined) => {
      if (!w) return null;
      return {
        utilizationPct: w.used_percent ?? 0,
        resetsAt: w.reset_at != null ? new Date(w.reset_at * 1000).toISOString() : undefined,
      };
    };

    return {
      session: toWindow(resp.rate_limit?.primary_window),
      weekly: toWindow(resp.rate_limit?.secondary_window),
      codeReview: toWindow(resp.code_review_rate_limit?.primary_window),
      credits: resp.credits
        ? {
            hasCredits: resp.credits.has_credits ?? null,
            unlimited: resp.credits.unlimited ?? null,
            balance: resp.credits.balance ?? null,
          }
        : null,
      planType: resp.plan_type ?? null,
      email: resp.email ?? null,
    };
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const quota = await this.fetch();
    if (!quota) {
      return unavailableUsage(this);
    }

    const windows: ProviderUsageWindow[] = [];
    if (quota.session) {
      windows.push(
        windowFromUsedPct({
          id: "session",
          label: "Session",
          utilizationPct: quota.session.utilizationPct,
          resetsAt: quota.session.resetsAt ?? null,
          tone: "ok",
        }),
      );
    }
    if (quota.weekly) {
      windows.push(
        windowFromUsedPct({
          id: "weekly",
          label: "Weekly",
          utilizationPct: quota.weekly.utilizationPct,
          resetsAt: quota.weekly.resetsAt ?? null,
          tone: quota.weekly.utilizationPct >= 70 ? "warning" : "ok",
        }),
      );
    }
    if (quota.codeReview) {
      windows.push(
        windowFromUsedPct({
          id: "code_review",
          label: "Code review",
          utilizationPct: quota.codeReview.utilizationPct,
          resetsAt: quota.codeReview.resetsAt ?? null,
          tone: quota.codeReview.utilizationPct >= 70 ? "warning" : "ok",
        }),
      );
    }

    const balances: ProviderUsageBalance[] = [];
    if (quota.credits?.balance !== undefined && quota.credits?.balance !== null) {
      balances.push({
        id: "credits",
        label: "Credits",
        remaining: quota.credits.balance,
        unit: "usd",
        tone: balanceToneFromRemaining(quota.credits.balance),
      });
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: quota.planType,
      windows,
      balances,
      details: [],
      error: null,
    };
  }

  private async readCodexAuth(): Promise<CodexAuthRecord | null> {
    const candidates = [
      ...(process.env["CODEX_HOME"] ? [join(process.env["CODEX_HOME"], "auth.json")] : []),
      join(homedir(), ".config", "codex", "auth.json"),
      join(this.codexHome, "auth.json"),
    ];
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      try {
        const raw = await fs.readFile(p, "utf8");
        const auth = JSON.parse(raw) as CodexAuth;
        if (auth.tokens?.access_token) return { auth, path: p };
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

    const res = await fetch("https://chatgpt.com/backend-api/wham/usage", { headers });
    if (res.status === 401 || res.status === 403) return "NEEDS_AUTH";
    if (!res.ok) throw new Error(`Codex usage API returned ${res.status}`);
    const text = await res.text();
    if (text.trim().startsWith("<")) return "NEEDS_AUTH";
    return CodexUsageResponseSchema.parse(JSON.parse(text));
  }

  private async refreshCodexToken(refreshToken: string): Promise<CodexTokenRefresh | null> {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CODEX_CLIENT_ID,
      refresh_token: refreshToken,
    });
    const res = await fetch("https://auth.openai.com/oauth/token", {
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
      // Non-fatal
    }
  }
}

// Helper for GitHub CLI hosts parsing
async function readGithubCliToken(): Promise<string | null> {
  const candidates: string[] = [];
  if (process.env["APPDATA"]) {
    candidates.push(join(process.env["APPDATA"], "GitHub CLI", "hosts.yml"));
  }
  candidates.push(join(homedir(), ".config", "gh", "hosts.yml"));

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = await fs.readFile(p, "utf8");
      const match = raw.match(/oauth_token:\s*["']?([a-zA-Z0-9_-]+)["']?/);
      if (match?.[1]) return match[1];
    } catch {
      continue;
    }
  }
  return null;
}

// Helper for Cursor SQLite auth status parsing
async function readCursorTokenFromSqlite(): Promise<string | null> {
  const dbPaths: string[] = [];
  if (process.env["APPDATA"]) {
    dbPaths.push(join(process.env["APPDATA"], "Cursor", "User", "globalStorage", "state.vscdb"));
  }
  dbPaths.push(
    join(
      homedir(),
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb",
    ),
  );
  dbPaths.push(join(homedir(), ".config", "Cursor", "User", "globalStorage", "state.vscdb"));

  for (const p of dbPaths) {
    if (!existsSync(p)) continue;
    try {
      const { stdout } = await execFileAsync(
        "sqlite3",
        [p, "SELECT value FROM ItemTable WHERE key = 'cursorAuthStatus'"],
        { timeout: CURSOR_SQLITE_TIMEOUT_MS },
      );
      if (stdout) {
        const parsed = JSON.parse(stdout.trim());
        if (parsed?.accessToken) return parsed.accessToken;
      }
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// GitHub Copilot
// ---------------------------------------------------------------------------
export class CopilotQuotaProvider implements QuotaProvider, ProviderUsageFetcher {
  readonly id = "copilot";
  readonly providerId = "copilot";
  readonly displayName = "GitHub Copilot";

  constructor(private readonly logger: Logger) {}

  async fetch(): Promise<ProviderQuotaMessage["payload"]["copilot"]> {
    const token =
      process.env["COPILOT_TOKEN"] ||
      process.env["GITHUB_TOKEN"] ||
      process.env["GITHUB_PAT"] ||
      (await readGithubCliToken());

    if (!token) return undefined;

    const res = await fetch("https://api.github.com/copilot_internal/user", {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/json",
        "Editor-Version": "vscode/1.96.2",
        "Editor-Plugin-Version": "copilot-chat/0.26.7",
        "User-Agent": "GitHubCopilotChat/0.26.7",
        "X-Github-Api-Version": "2025-04-01",
      },
    });

    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Copilot quota fetch failed");
      return undefined;
    }

    const resp = (await res.json()) as unknown as {
      copilot_plan?: string;
      quota_reset_date?: string;
    };
    return {
      plan: resp.copilot_plan || null,
      quotaResetDate: resp.quota_reset_date || null,
    };
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const quota = await this.fetch();
    if (!quota) return unavailableUsage(this);

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: quota.plan,
      windows: [],
      balances: [],
      details: quota.quotaResetDate
        ? [{ id: "reset", label: "Quota reset", value: quota.quotaResetDate }]
        : [],
      error: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------
export class CursorQuotaProvider implements QuotaProvider, ProviderUsageFetcher {
  readonly id = "cursor";
  readonly providerId = "cursor";
  readonly displayName = "Cursor";

  constructor(private readonly logger: Logger) {}

  async fetch(): Promise<ProviderQuotaMessage["payload"]["cursor"]> {
    const token =
      process.env["CURSOR_ACCESS_TOKEN"] ||
      process.env["CURSOR_TOKEN"] ||
      (await readCursorTokenFromSqlite());

    if (!token) return undefined;

    const res = await fetch(
      "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
        },
        body: JSON.stringify({}),
      },
    );

    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Cursor quota fetch failed");
      return undefined;
    }

    const resp = (await res.json()) as unknown as {
      planUsage?: {
        totalSpend?: number;
        includedSpend?: number;
        bonusSpend?: number;
        remaining?: number;
        limit?: number;
      } | null;
      billingCycleStart?: string;
      billingCycleEnd?: string;
    };
    return {
      planUsage: resp.planUsage
        ? {
            totalSpend:
              typeof resp.planUsage.totalSpend === "number"
                ? resp.planUsage.totalSpend / 100
                : null,
            includedSpend:
              typeof resp.planUsage.includedSpend === "number"
                ? resp.planUsage.includedSpend / 100
                : null,
            bonusSpend:
              typeof resp.planUsage.bonusSpend === "number"
                ? resp.planUsage.bonusSpend / 100
                : null,
            remaining:
              typeof resp.planUsage.remaining === "number" ? resp.planUsage.remaining / 100 : null,
            limit: typeof resp.planUsage.limit === "number" ? resp.planUsage.limit / 100 : null,
          }
        : null,
      billingCycleStart: resp.billingCycleStart
        ? new Date(Number(resp.billingCycleStart)).toISOString()
        : null,
      billingCycleEnd: resp.billingCycleEnd
        ? new Date(Number(resp.billingCycleEnd)).toISOString()
        : null,
    };
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const quota = await this.fetch();
    if (!quota) return unavailableUsage(this);

    const balances: ProviderUsageBalance[] = [];
    if (quota.planUsage) {
      balances.push({
        id: "plan_usage",
        label: "Plan usage",
        used: quota.planUsage.totalSpend,
        remaining: quota.planUsage.remaining,
        limit: quota.planUsage.limit,
        unit: "usd",
        resetsAt: quota.billingCycleEnd,
        tone: balanceToneFromRemaining(quota.planUsage.remaining),
      });
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: null,
      windows: [],
      balances,
      details: [],
      error: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Z.ai
// ---------------------------------------------------------------------------
export class ZaiQuotaProvider implements QuotaProvider, ProviderUsageFetcher {
  readonly id = "zai";
  readonly providerId = "zai";
  readonly displayName = "Z.ai";

  constructor(private readonly logger: Logger) {}

  async fetch(): Promise<ProviderQuotaMessage["payload"]["zai"]> {
    const token = process.env["ZAI_API_KEY"] || process.env["GLM_API_KEY"];
    if (!token) return undefined;

    const res = await fetch("https://api.z.ai/api/biz/subscription/list", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Z.ai quota fetch failed");
      return undefined;
    }

    const resp = (await res.json()) as unknown as {
      data?: Array<{
        productName?: string;
        status?: string;
        purchaseTime?: string;
        valid?: string;
      }>;
    };
    const sub = resp.data?.[0];
    if (!sub) return undefined;

    return {
      productName: sub.productName || null,
      status: sub.status || null,
      purchaseTime: sub.purchaseTime || null,
      valid: sub.valid || null,
    };
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const quota = await this.fetch();
    if (!quota) return unavailableUsage(this);

    const details: ProviderUsageDetail[] = [];
    if (quota.status) details.push({ id: "status", label: "Status", value: quota.status });
    if (quota.valid) details.push({ id: "valid", label: "Valid", value: quota.valid });
    if (quota.purchaseTime) {
      details.push({ id: "purchase_time", label: "Purchased", value: quota.purchaseTime });
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: quota.productName,
      windows: [],
      balances: [],
      details,
      error: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Grok
// ---------------------------------------------------------------------------
export class GrokQuotaProvider implements QuotaProvider, ProviderUsageFetcher {
  readonly id = "grok";
  readonly providerId = "grok";
  readonly displayName = "Grok";

  constructor(private readonly logger: Logger) {}

  async fetch(): Promise<ProviderQuotaMessage["payload"]["grok"]> {
    const token =
      process.env["GROK_API_KEY"] || process.env["GROK_TOKEN"] || (await this.readGrokToken());

    if (!token) return undefined;

    const res = await fetch("https://cli-chat-proxy.grok.com/v1/billing", {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-XAI-Token-Auth": "xai-grok-cli",
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Grok quota fetch failed");
      return undefined;
    }

    const resp = (await res.json()) as unknown as {
      config?: { monthlyLimit?: { val?: number } };
      usage?: { creditUsage?: number };
    };
    return {
      monthlyLimit: resp.config?.monthlyLimit?.val ?? null,
      creditUsage: resp.usage?.creditUsage ?? null,
    };
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const quota = await this.fetch();
    if (!quota) return unavailableUsage(this);

    const balances: ProviderUsageBalance[] = [];
    if (quota.monthlyLimit !== null || quota.creditUsage !== null) {
      const remaining =
        quota.monthlyLimit !== null && quota.creditUsage !== null
          ? Math.max(0, quota.monthlyLimit - quota.creditUsage)
          : null;
      balances.push({
        id: "monthly_credits",
        label: "Monthly credits",
        used: quota.creditUsage,
        remaining,
        limit: quota.monthlyLimit,
        unit: "credits",
        tone: balanceToneFromRemaining(remaining),
      });
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: null,
      windows: [],
      balances,
      details: [],
      error: null,
    };
  }

  private async readGrokToken(): Promise<string | null> {
    const p = join(homedir(), ".grok", "auth.json");
    if (!existsSync(p)) return null;
    try {
      const raw = await fs.readFile(p, "utf8");
      const auth = JSON.parse(raw);
      return auth.access_token || null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Kimi
// ---------------------------------------------------------------------------
export class KimiQuotaProvider implements QuotaProvider, ProviderUsageFetcher {
  readonly id = "kimi";
  readonly providerId = "kimi";
  readonly displayName = "Kimi";

  constructor(private readonly logger: Logger) {}

  async fetch(): Promise<ProviderQuotaMessage["payload"]["kimi"]> {
    const token =
      process.env["KIMI_TOKEN"] || process.env["KIMI_API_KEY"] || (await this.readKimiToken());

    if (!token) return undefined;

    const res = await fetch("https://api.kimi.com/coding/v1/usages", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Kimi quota fetch failed");
      return undefined;
    }

    const resp = (await res.json()) as unknown as {
      usage?: { limit?: string; remaining?: string; resetTime?: string };
    };
    return {
      limit: resp.usage?.limit || null,
      remaining: resp.usage?.remaining || null,
      resetTime: resp.usage?.resetTime || null,
    };
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const quota = await this.fetch();
    if (!quota) return unavailableUsage(this);

    const limit = quota.limit === null ? null : Number(quota.limit);
    const remaining = quota.remaining === null ? null : Number(quota.remaining);
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
          resetsAt: quota.resetTime,
          tone: "ok",
        },
      ],
      balances: [],
      details: [],
      error: null,
    };
  }

  private async readKimiToken(): Promise<string | null> {
    const p = join(homedir(), ".kimi", "credentials", "kimi-code.json");
    if (!existsSync(p)) return null;
    try {
      const raw = await fs.readFile(p, "utf8");
      const credentials = JSON.parse(raw);
      return credentials.access_token || null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Quota Fetcher Service
// ---------------------------------------------------------------------------
export interface ProviderUsageServiceOptions {
  logger: Logger;
  fetchers?: ProviderUsageFetcher[];
  claudeHome?: string;
  claudeKeychainReader?: () => Promise<ClaudeCredentials | null>;
  codexHome?: string;
  cacheTtlMs?: number;
  now?: () => number;
}

export interface ProviderUsageListResult {
  fetchedAt: string;
  providers: ProviderUsage[];
}

const DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS = 5 * 60 * 1000;

export const PROVIDER_USAGE_FETCHERS: readonly ProviderUsageFetcherManifestEntry[] = [
  {
    providerId: "claude",
    create: (options) =>
      new ClaudeQuotaProvider(options.logger, options.claudeHome, options.claudeKeychainReader),
  },
  {
    providerId: "codex",
    create: (options) => new CodexQuotaProvider(options.logger, options.codexHome),
  },
  {
    providerId: "copilot",
    create: (options) => new CopilotQuotaProvider(options.logger),
  },
  {
    providerId: "cursor",
    create: (options) => new CursorQuotaProvider(options.logger),
  },
  {
    providerId: "zai",
    create: (options) => new ZaiQuotaProvider(options.logger),
  },
  {
    providerId: "grok",
    create: (options) => new GrokQuotaProvider(options.logger),
  },
  {
    providerId: "kimi",
    create: (options) => new KimiQuotaProvider(options.logger),
  },
];

export function createProviderUsageFetchers(
  options: ProviderUsageFetcherFactoryOptions,
): ProviderUsageFetcher[] {
  return PROVIDER_USAGE_FETCHERS.map((entry) => entry.create(options));
}

export class ProviderUsageService {
  private readonly logger: Logger;
  private readonly fetchers: ProviderUsageFetcher[];
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private cached: { fetchedAtMs: number; result: ProviderUsageListResult } | null = null;

  constructor(options: ProviderUsageServiceOptions) {
    this.logger = options.logger.child({ module: "provider-usage-service" });
    this.fetchers =
      options.fetchers ??
      createProviderUsageFetchers({
        logger: this.logger,
        claudeHome: options.claudeHome,
        claudeKeychainReader: options.claudeKeychainReader,
        codexHome: options.codexHome,
      });
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async listUsage(options?: { forceRefresh?: boolean }): Promise<ProviderUsageListResult> {
    const nowMs = this.now();
    if (
      !options?.forceRefresh &&
      this.cached &&
      nowMs - this.cached.fetchedAtMs < this.cacheTtlMs
    ) {
      return this.cached.result;
    }

    const settled = await Promise.allSettled(this.fetchers.map((fetcher) => fetcher.fetchUsage()));
    const providers = settled.map((result, index) => {
      const fetcher = this.fetchers[index];
      if (result.status === "fulfilled") {
        return result.value;
      }
      this.logger.debug(
        { err: result.reason, providerId: fetcher.providerId },
        "Provider usage fetch failed",
      );
      return unavailableUsage({
        providerId: fetcher.providerId,
        displayName: fetcher.displayName,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });

    const result = { fetchedAt: new Date(nowMs).toISOString(), providers };
    this.cached = { fetchedAtMs: nowMs, result };
    return result;
  }
}

export class QuotaFetcherService {
  private readonly broadcastFn: (message: ProviderQuotaMessage) => void;
  private readonly logger: Logger;
  private readonly providers: QuotaProvider[];
  private readonly pollIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private cached: ProviderQuotaMessage | null = null;
  private isFetching = false;
  private pendingFetch = false;

  constructor(options: QuotaFetcherServiceOptions) {
    this.broadcastFn = options.broadcast;
    this.logger = options.logger.child({ module: "quota-fetcher" });
    this.pollIntervalMs = options.pollIntervalMs ?? 15 * 60 * 1000;

    this.providers = [
      new ClaudeQuotaProvider(this.logger, options.claudeHome, options.claudeKeychainReader),
      new CodexQuotaProvider(this.logger, options.codexHome),
      new CopilotQuotaProvider(this.logger),
      new CursorQuotaProvider(this.logger),
      new ZaiQuotaProvider(this.logger),
      new GrokQuotaProvider(this.logger),
      new KimiQuotaProvider(this.logger),
    ];
  }

  public start(): void {
    if (this.timer) return;
    void this.triggerFetch();
    this.timer = setInterval(() => {
      void this.triggerFetch();
    }, this.pollIntervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public getCached(): ProviderQuotaMessage | null {
    return this.cached;
  }

  public async triggerFetch(): Promise<void> {
    if (this.isFetching) {
      this.pendingFetch = true;
      return;
    }
    this.isFetching = true;
    try {
      await this.performFetch();
    } catch (err) {
      this.logger.warn({ err }, "QuotaFetcherService fetch failed");
    } finally {
      this.isFetching = false;
      if (this.pendingFetch) {
        this.pendingFetch = false;
        setImmediate(() => void this.triggerFetch());
      }
    }
  }

  private async performFetch(): Promise<void> {
    const results = await Promise.allSettled(this.providers.map((p) => p.fetch()));

    const payload: Record<string, unknown> = {
      fetchedAt: new Date().toISOString(),
    };

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      const result = results[i];
      if (result.status === "fulfilled" && result.value !== undefined) {
        payload[provider.id] = result.value;
      } else if (result.status === "rejected") {
        this.logger.debug({ err: result.reason, providerId: provider.id }, "Quota fetch failed");
      }
    }

    const next: ProviderQuotaMessage = {
      type: "provider_quota",
      payload: payload as ProviderQuotaMessage["payload"],
    };

    const { fetchedAt: _a, ...prevData } = this.cached?.payload ?? {};
    const { fetchedAt: _b, ...nextData } = next.payload;
    const changed = !this.cached || JSON.stringify(prevData) !== JSON.stringify(nextData);
    this.cached = next;
    if (changed) {
      this.broadcastFn(next);
    }
  }
}
