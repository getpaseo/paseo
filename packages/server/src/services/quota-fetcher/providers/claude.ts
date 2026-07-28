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
  toneFromUsedPct,
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
  resets_at: z.string().nullish(),
});

// Model- and surface-scoped weekly limits live in a `limits[]` array rather than a
// top-level `seven_day_<model>` key. Entries are validated one at a time (see
// scopedLimitsFromResponse) so a single malformed or newly-shaped entry cannot take down
// the windows that already parsed from the top-level keys.
const ClaudeScopeLabelSchema = z
  .object({ id: z.string().nullish(), display_name: z.string().nullish() })
  .nullish();

const ClaudeLimitSchema = z.object({
  kind: z.string(),
  percent: ApiNumberSchema.nullish(),
  resets_at: z.string().nullish(),
  scope: z.object({ model: ClaudeScopeLabelSchema, surface: ClaudeScopeLabelSchema }).nullish(),
});

const ClaudeUsageResponseSchema = z.object({
  five_hour: ClaudeUsageWindowSchema.nullish(),
  seven_day: ClaudeUsageWindowSchema.nullish(),
  seven_day_opus: ClaudeUsageWindowSchema.nullish(),
  seven_day_omelette: ClaudeUsageWindowSchema.nullish(),
  // Deliberately permissive: an additive section must never regress the top-level
  // windows, so shape validation happens per entry rather than here.
  limits: z.array(z.unknown()).nullish(),
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
type ClaudeLimit = z.infer<typeof ClaudeLimitSchema>;

const SCOPED_WEEKLY_KIND = "weekly_scoped";

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

/**
 * A weekly limit scoped to one model or one surface, normalized away from whichever
 * shape of the response described it.
 *
 * The API describes the same limit two ways during the migration: a legacy top-level
 * `seven_day_<model>` key, and an entry in `limits[]`. Everything downstream works on
 * this one representation so the two shapes are reconciled exactly once, in
 * `reconcileScopedLimits`, rather than at each place a window is built.
 */
interface ScopedLimit {
  dimension: "model" | "surface";
  /** The API's own identifier. Null on every response observed so far. */
  id: string | null;
  /** Display name, or the id when the API sends no display name. */
  name: string;
  usedPct: number | null;
  resetsAt: string | null;
}

// Windows that describe no particular model or surface.
const UNSCOPED_WINDOWS: ReadonlyArray<{
  field: "five_hour" | "seven_day";
  id: string;
  label: string;
}> = [
  { field: "five_hour", id: "five_hour", label: "Session" },
  { field: "seven_day", id: "weekly", label: "Weekly" },
];

// Scoped windows from before `limits[]` existed. Declaring the dimension here is what
// stops a *surface* named "Omelette" from being mistaken for the legacy Omelette *model*
// window: these keys are model-scoped by definition.
const LEGACY_SCOPED_WINDOWS: ReadonlyArray<{
  field: "seven_day_opus" | "seven_day_omelette";
  name: string;
}> = [
  { field: "seven_day_opus", name: "Opus" },
  { field: "seven_day_omelette", name: "Omelette" },
];

/** Fold a name down to the characters an id is allowed to carry. */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Whether two descriptions denote the same limit. This is the single definition of
 * identity for scoped limits; nothing else may compare them, and in particular nothing
 * may compare display labels, which are presentation rather than identity.
 *
 * - Different dimensions are never the same limit, so a surface and a model sharing a
 *   name stay apart.
 * - When both sides carry the API's own id, that id decides, so `fable-pro` and
 *   `fable_pro` stay apart.
 * - Otherwise fall back to the normalized name, which is the only link available between
 *   a legacy key (never has an id) and its `limits[]` counterpart.
 */
function isSameLimit(a: ScopedLimit, b: ScopedLimit): boolean {
  if (a.dimension !== b.dimension) return false;
  if (a.id && b.id) return a.id === b.id;
  return normalizeName(a.name) === normalizeName(b.name);
}

/**
 * Merge the legacy and `limits[]` descriptions into one limit per identity.
 *
 * A `limits[]` entry wins on identity because that is the representation the API is
 * migrating towards, so a limit keeps the same window id whichever shape carried it.
 * Its values are nullable though, so each field falls back to the legacy twin instead of
 * discarding a number the response did contain.
 */
function reconcileScopedLimits(
  legacy: ScopedLimit[],
  fromLimitsArray: ScopedLimit[],
): ScopedLimit[] {
  const reconciled = [...legacy];
  for (const limit of fromLimitsArray) {
    const index = reconciled.findIndex((candidate) => isSameLimit(candidate, limit));
    if (index === -1) {
      reconciled.push(limit);
      continue;
    }
    const twin = reconciled[index];
    reconciled[index] = {
      ...limit,
      usedPct: limit.usedPct ?? twin?.usedPct ?? null,
      resetsAt: limit.resetsAt ?? twin?.resetsAt ?? null,
    };
  }
  return reconciled;
}

function scopedLimitFromLegacy(
  spec: (typeof LEGACY_SCOPED_WINDOWS)[number],
  window: z.infer<typeof ClaudeUsageWindowSchema>,
): ScopedLimit {
  return {
    dimension: "model",
    id: null,
    name: spec.name,
    usedPct: window.utilization,
    resetsAt: window.resets_at ?? null,
  };
}

/** The scope of a `limits[]` entry, or null when it names nothing renderable. */
function scopedLimitFromEntry(limit: ClaudeLimit): ScopedLimit | null {
  for (const dimension of ["model", "surface"] as const) {
    const entry = limit.scope?.[dimension];
    const id = entry?.id?.trim() || null;
    const name = entry?.display_name?.trim() || id;
    if (name) {
      return {
        dimension,
        id,
        name,
        usedPct: limit.percent ?? null,
        resetsAt: limit.resets_at ?? null,
      };
    }
  }
  return null;
}

// The client uses window ids as React keys, so they must be stable across refreshes and
// unique within a response. An API-supplied id is already an identifier and is used
// verbatim (ids elsewhere carry punctuation too, e.g. MiniMax's `interval_MiniMax-M2.7`);
// only a name fallback is normalized. Normalizing an id would collapse `fable-pro` and
// `fable_pro` into one window.
function scopedWindowId(limit: ScopedLimit): string {
  return `weekly_${limit.dimension}_${limit.id ?? normalizeName(limit.name)}`;
}

// Backstop for the one residual case identity cannot rule out: an entry whose verbatim id
// equals another entry's normalized name. Suffix rather than drop, because a missing bar
// is the bug this change exists to fix.
function uniqueWindowId(candidate: string, taken: Set<string>): string {
  if (!taken.has(candidate)) return candidate;
  for (let suffix = 2; ; suffix += 1) {
    const next = `${candidate}_${suffix}`;
    if (!taken.has(next)) return next;
  }
}

function legacyScopedLimits(resp: ClaudeUsageResponse): ScopedLimit[] {
  const limits: ScopedLimit[] = [];
  for (const spec of LEGACY_SCOPED_WINDOWS) {
    const window = resp[spec.field];
    if (window) limits.push(scopedLimitFromLegacy(spec, window));
  }
  return limits;
}

function unscopedWindows(resp: ClaudeUsageResponse): ProviderUsageWindow[] {
  const windows: ProviderUsageWindow[] = [];
  for (const spec of UNSCOPED_WINDOWS) {
    const window = resp[spec.field];
    if (!window) continue;
    windows.push(
      windowFromUsedPct({
        id: spec.id,
        label: spec.label,
        utilizationPct: window.utilization,
        resetsAt: window.resets_at ?? null,
        tone: toneFromUsedPct(window.utilization),
      }),
    );
  }
  return windows;
}

function scopedWindows(limits: ScopedLimit[]): ProviderUsageWindow[] {
  const taken = new Set<string>();
  return limits.map((limit) => {
    const id = uniqueWindowId(scopedWindowId(limit), taken);
    taken.add(id);
    // Emitted even at 0% and inactive: a zero bar answers "how much of this model have I
    // used", and the bar must not come and go between refreshes.
    return windowFromUsedPct({
      id,
      label: `Weekly \u00b7 ${limit.name}`,
      utilizationPct: limit.usedPct,
      resetsAt: limit.resetsAt,
      tone: toneFromUsedPct(limit.usedPct),
    });
  });
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

  private readonly logger: Logger;
  private readonly claudeHome: string;
  private readonly readKeychainCredentials: () => Promise<unknown | null>;
  private readonly platform: typeof process.platform;
  private readonly fetchApi: ProviderApiFetch;

  constructor(options: ClaudeQuotaProviderOptions) {
    this.logger = options.logger.child({ module: "claude-quota-provider" });
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

    const scoped = reconcileScopedLimits(
      legacyScopedLimits(resp),
      this.scopedLimitsFromResponse(resp.limits),
    );
    const windows = [...unscopedWindows(resp), ...scopedWindows(scoped)];

    if (windows.length === 0) {
      // The response parsed but described nothing. That silence is how the previous
      // shape change went unnoticed, so make it greppable. `warn` and not `debug`
      // because file logging defaults to `info`.
      this.logger.warn("Claude usage response parsed but produced no windows");
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

  /**
   * Scoped limits carried by `limits[]`.
   *
   * Entries are validated one at a time so a single malformed or newly-shaped entry
   * cannot fail the whole response and take the windows that already parsed with it.
   */
  private scopedLimitsFromResponse(limits: ClaudeUsageResponse["limits"]): ScopedLimit[] {
    if (!limits) return [];

    const parsed: ScopedLimit[] = [];
    for (const entry of limits) {
      const result = ClaudeLimitSchema.safeParse(entry);
      if (!result.success) {
        this.logger.warn({ err: result.error }, "Skipping unparseable Claude usage limit entry");
        continue;
      }
      if (result.data.kind !== SCOPED_WEEKLY_KIND) continue;

      const limit = scopedLimitFromEntry(result.data);
      if (!limit) {
        this.logger.warn("Skipping scoped Claude usage limit with no resolvable scope name");
        continue;
      }
      parsed.push(limit);
    }
    return parsed;
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
