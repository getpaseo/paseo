import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageDetail,
} from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNumberSchema,
  toneFromUsedPct,
  usedPctOf,
  fetchProviderApi,
  unavailableUsage,
} from "../usage.js";

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
      billingPeriodEnd: z.string().nullish(),
    })
    .nullish(),
  usage: z
    .object({
      creditUsage: ApiNumberSchema.optional(),
    })
    .nullish(),
});

const GrokTokenResponseSchema = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: ApiNumberSchema.optional(),
});

const GROK_TOKEN_EXPIRY_SKEW_MS = 60_000;
const GROK_DEFAULT_ISSUER = "https://auth.x.ai";

interface GrokAuthEntry {
  topKey: string | null;
  token: string;
  expiresAt: string | null;
  refreshToken: string | null;
  issuer: string | null;
  clientId: string | null;
}

interface GrokQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  /** Override home directory (tests). Production uses os.homedir(). */
  homeDir?: string;
}

function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const parsed = Date.parse(expiresAt);
  return !Number.isNaN(parsed) && parsed <= Date.now() + GROK_TOKEN_EXPIRY_SKEW_MS;
}

function entryFromValue(topKey: string | null, value: unknown): GrokAuthEntry | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const token = record["access_token"] ?? record["key"];
  if (typeof token !== "string" || token.length === 0) return null;
  const scopedIssuer = topKey?.includes("::") ? topKey.split("::")[0] : null;
  const scopedClient = topKey?.includes("::") ? topKey.split("::")[1] : null;
  return {
    topKey,
    token,
    expiresAt: typeof record["expires_at"] === "string" ? record["expires_at"] : null,
    refreshToken: typeof record["refresh_token"] === "string" ? record["refresh_token"] : null,
    issuer: typeof record["oidc_issuer"] === "string" ? record["oidc_issuer"] : scopedIssuer,
    clientId:
      typeof record["oidc_client_id"] === "string" ? record["oidc_client_id"] : scopedClient,
  };
}

/** All usable auth entries from ~/.grok/auth.json (legacy flat or current nested shape). */
function extractGrokAuthEntries(auth: unknown): GrokAuthEntry[] {
  if (auth == null || typeof auth !== "object" || Array.isArray(auth)) return [];
  const record = auth as Record<string, unknown>;

  const entries: GrokAuthEntry[] = [];
  const flat = entryFromValue(null, record);
  if (flat) entries.push(flat);

  const scoped = Object.entries(record).filter(([key]) =>
    key.startsWith("https://auth.x.ai::"),
  );
  const candidates = scoped.length > 0 ? scoped : Object.entries(record);
  for (const [key, value] of candidates) {
    const entry = entryFromValue(key, value);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Resolve a Grok CLI token from ~/.grok/auth.json (legacy or current nested shape). */
export function extractGrokTokenFromAuth(auth: unknown): string | null {
  for (const entry of extractGrokAuthEntries(auth)) {
    if (!isExpired(entry.expiresAt)) return entry.token;
  }
  return null;
}

export class GrokQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "grok";
  readonly displayName = "Grok";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly homeDir: string | undefined;

  constructor(options: GrokQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
    this.homeDir = options.homeDir;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const token =
      process.env["GROK_API_KEY"] || process.env["GROK_TOKEN"] || (await this.readGrokToken());

    if (!token) return unavailableUsage(this);

    const res = await fetchProviderApi(
      this.fetchApi,
      "https://cli-chat-proxy.grok.com/v1/billing",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-XAI-Token-Auth": "xai-grok-cli",
          Accept: "application/json",
        },
      },
    );

    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Grok usage fetch failed");
      return unavailableUsage(this);
    }

    const resp = GrokUsageResponseSchema.parse(await res.json());
    const monthlyLimit = resp.config?.monthlyLimit?.val ?? null;
    // Live CLI billing uses config.used.val; older mocks used usage.creditUsage.
    const creditUsage = resp.config?.used?.val ?? resp.usage?.creditUsage ?? null;
    const balances: ProviderUsageBalance[] = [];
    if (monthlyLimit !== null || creditUsage !== null) {
      const remaining =
        monthlyLimit !== null && creditUsage !== null
          ? Math.max(0, monthlyLimit - creditUsage)
          : null;
      balances.push({
        id: "monthly_credits",
        label: "Monthly credits",
        used: creditUsage,
        remaining,
        limit: monthlyLimit,
        unit: "credits",
        tone: toneFromUsedPct(usedPctOf(creditUsage, monthlyLimit)),
      });
    }

    const details: ProviderUsageDetail[] = [];
    if (resp.config?.billingPeriodEnd) {
      details.push({
        id: "billing_period_end",
        label: "Billing period ends",
        value: resp.config.billingPeriodEnd.slice(0, 10),
      });
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: null,
      windows: [],
      balances,
      details,
      error: null,
    };
  }

  private async readGrokToken(): Promise<string | null> {
    for (const path of this.candidateAuthPaths()) {
      const token = await this.readTokenFromFile(path);
      if (token) return token;
    }
    return null;
  }

  private candidateAuthPaths(): string[] {
    const paths: string[] = [];
    if (process.env["GROK_AUTH_FILE"]) paths.push(process.env["GROK_AUTH_FILE"]);
    // homeDir override is for tests: Windows os.homedir() ignores $HOME (uses USERPROFILE).
    paths.push(join(this.homeDir ?? homedir(), ".grok", "auth.json"));
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

    const entries = extractGrokAuthEntries(raw);
    for (const entry of entries) {
      if (!isExpired(entry.expiresAt)) return entry.token;
    }
    // Every stored token is expired: refresh via OIDC and persist the rotated
    // tokens back to the same file, exactly like the Grok CLI does.
    for (const entry of entries) {
      if (!entry.refreshToken) continue;
      const token = await this.refreshEntry(path, raw, entry);
      if (token) return token;
    }
    return null;
  }

  private async refreshEntry(
    path: string,
    raw: Record<string, unknown>,
    entry: GrokAuthEntry,
  ): Promise<string | null> {
    const issuer = entry.issuer ?? GROK_DEFAULT_ISSUER;
    try {
      const discoRes = await fetchProviderApi(
        this.fetchApi,
        `${issuer}/.well-known/openid-configuration`,
        { headers: { Accept: "application/json" } },
      );
      if (!discoRes.ok) return null;
      const tokenEndpoint = z
        .object({ token_endpoint: z.string() })
        .parse(await discoRes.json()).token_endpoint;

      const res = await fetchProviderApi(this.fetchApi, tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: entry.refreshToken as string,
          ...(entry.clientId ? { client_id: entry.clientId } : {}),
        }).toString(),
      });
      if (!res.ok) return null;
      const tok = GrokTokenResponseSchema.parse(await res.json());
      if (!tok.access_token) return null;

      const target = entry.topKey ? raw[entry.topKey] : raw;
      if (!target || typeof target !== "object" || Array.isArray(target)) return null;
      const record = target as Record<string, unknown>;
      record["key"] = tok.access_token;
      if (tok.refresh_token) record["refresh_token"] = tok.refresh_token;
      record["expires_at"] = new Date(
        Date.now() + Number(tok.expires_in ?? 3600) * 1000,
      ).toISOString();
      await fs.writeFile(path, JSON.stringify(raw, null, 2));
      return tok.access_token;
    } catch {
      return null;
    }
  }
}
