import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "pino";
import { z } from "zod";
import type { ProviderUsage, ProviderUsageBalance } from "../../../server/messages.js";
import { expandTilde } from "../../../utils/path.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNumberSchema,
  balanceToneFromRemaining,
  fetchProviderApi,
  unavailableUsage,
} from "../usage.js";

const execFileAsync = promisify(execFile);
const GROK_AUTH_REFRESH_TIMEOUT_MS = 10_000;
const GROK_BILLING_FETCH_ATTEMPTS = 3;
const GROK_BILLING_RETRY_DELAY_MS = 250;

const DEFAULT_GROK_CLI_PROXY_BASE = "https://cli-chat-proxy.grok.com";
const GROK_NETWORK_ERROR_MESSAGE =
  "Couldn't reach Grok billing API. Check that cli-chat-proxy.grok.com is reachable (proxy/VPN rules often block it).";

const GrokUsageResponseSchema = z.object({
  config: z
    .object({
      monthlyLimit: z
        .object({
          val: ApiNumberSchema.optional(),
        })
        .nullish(),
      used: z
        .object({
          val: ApiNumberSchema.optional(),
        })
        .nullish(),
    })
    .nullish(),
  usage: z
    .object({
      creditUsage: ApiNumberSchema.optional(),
    })
    .nullish(),
});

const GrokSettingsResponseSchema = z.object({
  subscription_tier_display: z.string().trim().min(1).optional(),
});

const GrokAuthEntrySchema = z.object({
  access_token: z.string().trim().min(1).optional(),
  key: z.string().trim().min(1).optional(),
  email: z.string().trim().email().optional(),
  first_name: z.string().trim().min(1).optional(),
  last_name: z.string().trim().min(1).optional(),
  principal_type: z.string().trim().min(1).optional(),
  expires_at: z.string().trim().min(1).optional(),
  refresh_token: z.string().trim().min(1).optional(),
});
const GrokAuthStoreSchema = z.record(z.string(), GrokAuthEntrySchema);

interface GrokAuth {
  token: string;
  details: NonNullable<ProviderUsage["details"]>;
  expiresAt: string | null;
  canRefresh: boolean;
}

interface GrokQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  grokHome?: string;
  /** Override for tests / `GROK_CLI_CHAT_PROXY_BASE_URL`. */
  proxyBaseUrl?: string;
  refreshAuth?: () => Promise<void>;
  now?: () => number;
}

export class GrokQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "grok";
  readonly displayName = "Grok";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly grokHome: string;
  private readonly proxyBaseUrl: string;
  private readonly refreshAuth: () => Promise<void>;
  private readonly now: () => number;

  constructor(options: GrokQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
    this.grokHome = resolveGrokHome(options.grokHome);
    this.proxyBaseUrl = resolveGrokCliProxyBase(options.proxyBaseUrl);
    this.refreshAuth = options.refreshAuth ?? refreshGrokCliAuth;
    this.now = options.now ?? Date.now;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const environmentToken = process.env["GROK_API_KEY"] || process.env["GROK_TOKEN"];
    let storedAuth = await this.readGrokAuth();
    if (!environmentToken && storedAuth && this.isExpired(storedAuth.expiresAt)) {
      storedAuth = await this.refreshStoredAuth();
    }

    let token = environmentToken || storedAuth?.token;
    if (!token) return unavailableUsage(this);

    try {
      const billing = await this.fetchBillingWithAuthRetry({
        token,
        environmentToken: Boolean(environmentToken),
        canRefresh: Boolean(storedAuth?.canRefresh),
      });
      if (!billing.ok) {
        this.logger.debug({ status: billing.status }, "Grok usage fetch failed");
        return unavailableUsage(this);
      }
      token = billing.token;
      storedAuth = billing.storedAuth ?? storedAuth;

      const resp = GrokUsageResponseSchema.parse(await billing.response.json());
      return {
        providerId: this.providerId,
        displayName: this.displayName,
        status: "available",
        planLabel: await this.fetchPlanLabel(token),
        windows: [],
        balances: resolveGrokBalances(resp),
        details: storedAuth?.details ?? [],
        error: null,
      };
    } catch (error) {
      if (!isTransientFetchError(error)) throw error;
      this.logger.debug({ err: error, proxyBaseUrl: this.proxyBaseUrl }, "Grok usage fetch failed");
      return this.networkErrorUsage(storedAuth?.details ?? []);
    }
  }

  private networkErrorUsage(details: NonNullable<ProviderUsage["details"]>): ProviderUsage {
    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "error",
      planLabel: null,
      windows: [],
      balances: [],
      details,
      error: GROK_NETWORK_ERROR_MESSAGE,
    };
  }

  private async fetchBillingWithAuthRetry(input: {
    token: string;
    environmentToken: boolean;
    canRefresh: boolean;
  }): Promise<{
    ok: boolean;
    status: number;
    token: string;
    response: Response;
    storedAuth: GrokAuth | null;
  }> {
    let token = input.token;
    let storedAuth: GrokAuth | null = null;
    let response = await this.fetchBilling(token);
    if (!input.environmentToken && response.status === 401 && input.canRefresh) {
      storedAuth = await this.refreshStoredAuth();
      token = storedAuth?.token ?? "";
      if (!token) {
        return { ok: false, status: 401, token, response, storedAuth };
      }
      response = await this.fetchBilling(token);
    }
    return {
      ok: response.ok,
      status: response.status,
      token,
      response,
      storedAuth,
    };
  }

  private billingUrl(path: string): string {
    return `${this.proxyBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  private grokAuthHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "X-XAI-Token-Auth": "xai-grok-cli",
      Accept: "application/json",
    };
  }

  private async fetchBilling(token: string): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= GROK_BILLING_FETCH_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetchProviderApi(this.fetchApi, this.billingUrl("/v1/billing"), {
          headers: this.grokAuthHeaders(token),
        });
        if (response.ok || response.status < 500 || attempt === GROK_BILLING_FETCH_ATTEMPTS) {
          return response;
        }
        this.logger.debug(
          { status: response.status, attempt },
          "Grok billing fetch returned a retryable status",
        );
      } catch (error) {
        lastError = error;
        if (attempt === GROK_BILLING_FETCH_ATTEMPTS || !isTransientFetchError(error)) {
          throw error;
        }
        this.logger.debug({ err: error, attempt }, "Grok billing fetch failed transiently");
      }
      await delay(GROK_BILLING_RETRY_DELAY_MS * attempt);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async fetchPlanLabel(token: string): Promise<string | null> {
    try {
      const res = await fetchProviderApi(this.fetchApi, this.billingUrl("/v1/settings"), {
        headers: this.grokAuthHeaders(token),
      });
      if (!res.ok) return null;
      const settings = GrokSettingsResponseSchema.safeParse(await res.json());
      return settings.success ? (settings.data.subscription_tier_display ?? null) : null;
    } catch (error) {
      this.logger.debug({ err: error }, "Grok subscription plan fetch failed");
      return null;
    }
  }

  private async refreshStoredAuth(): Promise<GrokAuth | null> {
    try {
      await this.refreshAuth();
      return this.readGrokAuth();
    } catch (error) {
      this.logger.debug({ err: error }, "Grok CLI credential refresh failed");
      return null;
    }
  }

  private isExpired(expiresAt: string | null): boolean {
    if (!expiresAt) return false;
    const expiresAtMs = Date.parse(expiresAt);
    return Number.isFinite(expiresAtMs) && expiresAtMs <= this.now();
  }

  private async readGrokAuth(): Promise<GrokAuth | null> {
    const path = join(this.grokHome, "auth.json");
    if (!existsSync(path)) return null;
    try {
      const auth = JSON.parse(await fs.readFile(path, "utf8"));
      const directEntry = GrokAuthEntrySchema.safeParse(auth);
      const directAuth = resolveGrokAuthEntry(directEntry.success ? directEntry.data : null);
      if (directAuth) return directAuth;

      const store = GrokAuthStoreSchema.safeParse(auth);
      if (!store.success) return null;
      for (const entry of Object.values(store.data)) {
        const entryAuth = resolveGrokAuthEntry(entry);
        if (entryAuth) return entryAuth;
      }
      return null;
    } catch {
      return null;
    }
  }
}

function resolveGrokBalances(
  response: z.infer<typeof GrokUsageResponseSchema>,
): ProviderUsageBalance[] {
  const monthlyLimit = response.config?.monthlyLimit?.val ?? null;
  const creditUsage = response.config?.used?.val ?? response.usage?.creditUsage ?? null;
  if (monthlyLimit === null && creditUsage === null) return [];

  const remaining =
    monthlyLimit !== null && creditUsage !== null ? Math.max(0, monthlyLimit - creditUsage) : null;
  return [
    {
      id: "monthly_credits",
      label: "Monthly credits",
      used: creditUsage,
      remaining,
      limit: monthlyLimit,
      unit: "credits",
      tone: balanceToneFromRemaining(remaining),
    },
  ];
}

function resolveGrokHome(configuredHome: string | undefined): string {
  const grokHome = configuredHome ?? process.env["GROK_HOME"];
  return grokHome ? resolve(expandTilde(grokHome)) : join(homedir(), ".grok");
}

function resolveGrokCliProxyBase(configuredBase: string | undefined): string {
  const raw =
    configuredBase ?? process.env["GROK_CLI_CHAT_PROXY_BASE_URL"] ?? DEFAULT_GROK_CLI_PROXY_BASE;
  const trimmed = raw.trim().replace(/\/+$/, "");
  // CLI env docs use either origin or origin+/v1; normalize to origin.
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

function resolveGrokAuthEntry(entry: z.infer<typeof GrokAuthEntrySchema> | null): GrokAuth | null {
  if (!entry) return null;

  const token = entry.access_token ?? entry.key;
  if (!token) return null;

  const displayName = [entry.first_name, entry.last_name].filter(Boolean).join(" ");
  const details: NonNullable<ProviderUsage["details"]> = [];
  if (entry.email) {
    details.push({ id: "account_email", label: "Account email", value: entry.email });
  }
  if (displayName) {
    details.push({ id: "account_name", label: "Account", value: displayName });
  }
  if (entry.principal_type) {
    details.push({ id: "account_type", label: "Account type", value: entry.principal_type });
  }

  return {
    token,
    details,
    expiresAt: entry.expires_at ?? null,
    canRefresh: Boolean(entry.refresh_token),
  };
}

async function refreshGrokCliAuth(): Promise<void> {
  // `grok models` is the official non-interactive command that performs the CLI's silent OIDC refresh.
  await execFileAsync("grok", ["models"], { timeout: GROK_AUTH_REFRESH_TIMEOUT_MS });
}

function isTransientFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timeout")
  ) {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = String((cause as { code?: unknown }).code);
    return (
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "UND_ERR_CONNECT_TIMEOUT" ||
      code === "UND_ERR_HEADERS_TIMEOUT" ||
      code === "UND_ERR_SOCKET"
    );
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((settle) => {
    setTimeout(settle, ms);
  });
}
