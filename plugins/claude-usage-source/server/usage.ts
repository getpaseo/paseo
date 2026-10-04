import { discoverOmp, piAuthPath, readHarness, type StoreLookup } from "./stores.js";
import type { UsageInput } from "../shared/input.js";
import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  type UsageAccount,
  type UsageScope,
  windowFromUsedPct,
  type UsageReport,
  type UsageWindow,
  type UsageDetail,
} from "@getpaseo/plugin/server/usage";

const ApiNumberSchema = z.coerce.number().finite();

const execFileAsync = promisify(execFile);
const CLAUDE_KEYCHAIN_TIMEOUT_MS = 2_000;
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

const ClaudeCredentialsSchema = z.object({
  claudeAiOauth: z
    .object({
      accessToken: z.string().optional(),
      expiresAt: z.number().optional(),
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

type ClaudeCredentials = z.infer<typeof ClaudeCredentialsSchema>;
type ClaudeUsageResponse = z.infer<typeof ClaudeUsageResponseSchema>;
type ClaudeLimit = z.infer<typeof ClaudeLimitSchema>;

const SCOPED_WEEKLY_KIND = "weekly_scoped";

interface ClaudeCredentialRecord {
  expires?: number;
  oauth: { accessToken: string } & NonNullable<ClaudeCredentials["claudeAiOauth"]>;
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
  shortLabel: string;
  summary: boolean;
}> = [
  { field: "five_hour", id: "five_hour", label: "Session", shortLabel: "5h", summary: true },
  { field: "seven_day", id: "weekly", label: "Weekly", shortLabel: "wk", summary: true },
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

function unscopedWindows(resp: ClaudeUsageResponse): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const spec of UNSCOPED_WINDOWS) {
    const window = resp[spec.field];
    if (!window) continue;
    windows.push(
      windowFromUsedPct({
        id: spec.id,
        label: spec.label,
        shortLabel: spec.shortLabel,
        summary: spec.summary,
        utilizationPct: window.utilization,
        resetsAt: window.resets_at ?? null,
        tone: toneFromUsedPct(window.utilization),
      }),
    );
  }
  return windows;
}

function scopedWindows(limits: ScopedLimit[]): UsageWindow[] {
  const taken = new Set<string>();
  return limits.map((limit) => {
    const id = uniqueWindowId(scopedWindowId(limit), taken);
    taken.add(id);
    // Emitted even at 0% and inactive: a zero bar answers "how much of this model have I
    // used", and the bar must not come and go between refreshes.
    return windowFromUsedPct({
      id,
      label: `Weekly \u00b7 ${limit.name}`,
      shortLabel: `wk ${limit.name}`,
      utilizationPct: limit.usedPct,
      resetsAt: limit.resetsAt,
      tone: toneFromUsedPct(limit.usedPct),
    });
  });
}

type ClaudeKeychainCommandRunner = (args: string[]) => Promise<string | null>;

// Keep this in sync with Claude Code's Keychain account derivation.
const CLAUDE_KEYCHAIN_ACCOUNT_PATTERN = /^[a-zA-Z0-9._-]+$/;
const CLAUDE_KEYCHAIN_FALLBACK_ACCOUNT = "claude-code-user";

export function claudeKeychainAccount(
  user: string = process.env["USER"] || userInfo().username,
): string {
  return CLAUDE_KEYCHAIN_ACCOUNT_PATTERN.test(user) ? user : CLAUDE_KEYCHAIN_FALLBACK_ACCOUNT;
}

async function runSecurityCommand(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("security", args, {
      timeout: CLAUDE_KEYCHAIN_TIMEOUT_MS,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Read Claude Code's account-specific Keychain item, then try the legacy lookup. */
export async function readClaudeKeychainCredentials(
  run: ClaudeKeychainCommandRunner = runSecurityCommand,
  account: string = claudeKeychainAccount(),
  service: string = CLAUDE_KEYCHAIN_SERVICE,
): Promise<unknown | null> {
  const lookups = [
    ["find-generic-password", "-a", account, "-w", "-s", service],
    ["find-generic-password", "-w", "-s", service],
  ];

  for (const args of lookups) {
    const raw = await run(args);
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const creds = ClaudeCredentialsSchema.safeParse(parsed);
    if (creds.success && creds.data.claudeAiOauth?.accessToken) return parsed;
  }
  return null;
}

interface ClaudeCredentialLookup extends StoreLookup {
  readKeychainCredentials?: (service: string, account: string) => Promise<unknown | null>;
  claudeHome?: string;
}

function claudeCredentialPath(lookup: ClaudeCredentialLookup): string {
  const home = lookup.home ?? homedir();
  const env = lookup.env ?? process.env;
  const claudeHome = lookup.claudeHome ?? env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  return join(claudeHome, ".credentials.json");
}

async function keychainCredentialRecord(
  lookup: ClaudeCredentialLookup,
  route = claudeKeychainRoute(lookup),
): Promise<ClaudeCredentialRecord | null> {
  if ((lookup.platform ?? process.platform) !== "darwin") return null;
  const parsed = ClaudeCredentialsSchema.safeParse(
    await (lookup.readKeychainCredentials
      ? lookup.readKeychainCredentials(route.service, route.account)
      : readClaudeKeychainCredentials(undefined, route.account, route.service)),
  );
  return parsed.success ? toCredentialRecord(parsed.data) : null;
}

export async function discover(
  scope: UsageScope,
  lookup: ClaudeCredentialLookup = {},
  fetchApi: typeof fetch = fetch,
): Promise<UsageAccount[]> {
  if (scope.kind === "session")
    lookup = {
      ...lookup,
      env: scope.env,
      home: scope.env.HOME || scope.env.USERPROFILE || homedir(),
    };
  const candidates =
    scope.kind === "global" ? await globalRoutes(lookup) : await sessionRoutes(scope, lookup);
  const accounts: UsageAccount[] = [];
  for (const input of candidates) {
    const credentials = await resolveClaudeCredentials(input, lookup);
    if (!credentials) continue;
    const fallback = { key: hashAccountKey(JSON.stringify(input.route)), input };
    if (credentials.expires !== undefined && credentials.expires <= (lookup.now ?? Date.now)()) {
      accounts.push(fallback);
      continue;
    }
    try {
      const profile = await readProfile(
        credentials.oauth.accessToken,
        fetchApi,
        lookup.now ?? Date.now,
      );
      accounts.push("status" in profile ? fallback : { ...profile, input });
    } catch {
      // Keep the login visible; fetching usage reports the vendor failure.
      accounts.push(fallback);
    }
  }
  return accounts;
}

function claudeKeychainRoute(lookup: ClaudeCredentialLookup) {
  const env = lookup.env ?? process.env;
  const configDir = env.CLAUDE_CONFIG_DIR;
  // macOS still uses Keychain with CLAUDE_CONFIG_DIR, with an entry keyed to that directory:
  // https://code.claude.com/docs/en/authentication#credential-management
  // Verified in @anthropic-ai/claude-code 2.1.59, package/cli.js: _c() appends the first
  // 8 SHA-256 hex characters of HA() (the NFC-normalized config directory).
  const suffix = configDir ? `-${hashAccountKey(configDir.normalize("NFC")).slice(0, 8)}` : "";
  return {
    store: "keychain" as const,
    service: `${CLAUDE_KEYCHAIN_SERVICE}${suffix}`,
    account: claudeKeychainAccount(env.USER),
  };
}

async function claudeRoute(lookup: ClaudeCredentialLookup): Promise<UsageInput> {
  const route = claudeKeychainRoute(lookup);
  return (await keychainCredentialRecord(lookup, route))
    ? { route }
    : { route: { store: "claude", path: claudeCredentialPath(lookup) } };
}

async function globalRoutes(lookup: ClaudeCredentialLookup): Promise<UsageInput[]> {
  return [
    await claudeRoute(lookup),
    { route: { store: "pi", path: piAuthPath(lookup) } },
    ...discoverOmp(lookup).map((route) => ({ route })),
  ];
}

async function sessionRoutes(
  scope: Extract<UsageScope, { kind: "session" }>,
  lookup: ClaudeCredentialLookup,
): Promise<UsageInput[]> {
  if (scope.provider === "claude") {
    const env = scope.env;
    const foreign =
      env.ANTHROPIC_BASE_URL &&
      env.ANTHROPIC_BASE_URL.replace(/\/+$/, "") !== "https://api.anthropic.com";
    if (enabled(env.CLAUDE_CODE_USE_BEDROCK) || enabled(env.CLAUDE_CODE_USE_VERTEX) || foreign)
      return [];
    return [await claudeRoute(lookup)];
  }
  if (!scope.model?.startsWith("anthropic/")) return [];
  if (scope.provider === "pi") return [{ route: { store: "pi", path: piAuthPath(lookup) } }];
  if (scope.provider === "omp") return discoverOmp(lookup).map((route) => ({ route }));
  return [];
}

function enabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

/** Re-read the selected login; the harness owns token refresh. */
export async function resolveClaudeCredentials(
  input: UsageInput,
  lookup: ClaudeCredentialLookup = {},
): Promise<ClaudeCredentialRecord | null> {
  const route = input.route;
  if (route.store === "claude") return readCredentialFile(route.path);
  if (route.store === "keychain")
    return keychainCredentialRecord(lookup, {
      store: "keychain",
      service: route.service ?? CLAUDE_KEYCHAIN_SERVICE,
      account: route.account ?? claudeKeychainAccount(),
    });
  const oauth = await readHarness(route, lookup);
  return oauth ? { oauth: { accessToken: oauth.access }, expires: oauth.expires } : null;
}

async function readCredentialFile(path: string): Promise<ClaudeCredentialRecord | null> {
  if (!existsSync(path)) return null;
  try {
    return toCredentialRecord(
      ClaudeCredentialsSchema.parse(JSON.parse(await fs.readFile(path, "utf8"))),
    );
  } catch {
    return null;
  }
}

function toCredentialRecord(credentials: ClaudeCredentials): ClaudeCredentialRecord | null {
  const oauth = credentials.claudeAiOauth;
  return oauth?.accessToken
    ? { oauth: { ...oauth, accessToken: oauth.accessToken }, expires: oauth.expiresAt }
    : null;
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
  credentialLookup: ClaudeCredentialLookup = {},
): Promise<UsageReport> {
  /**
   * Scoped limits carried by `limits[]`.
   *
   * Entries are validated one at a time so a single malformed or newly-shaped entry
   * cannot fail the whole response and take the windows that already parsed with it.
   */
  function scopedLimitsFromResponse(limits: ClaudeUsageResponse["limits"]): ScopedLimit[] {
    if (!limits) return [];

    const parsed: ScopedLimit[] = [];
    for (const entry of limits) {
      const result = ClaudeLimitSchema.safeParse(entry);
      if (!result.success) {
        console.warn({ err: result.error }, "Skipping unparseable Claude usage limit entry");
        continue;
      }
      if (result.data.kind !== SCOPED_WEEKLY_KIND) continue;

      const limit = scopedLimitFromEntry(result.data);
      if (!limit) {
        console.warn("Skipping scoped Claude usage limit with no resolvable scope name");
        continue;
      }
      parsed.push(limit);
    }
    return parsed;
  }

  async function callClaudeApi(token: string, now: number): Promise<ClaudeUsageResponse | number> {
    for (const [key, until] of rateLimitedUntil) {
      if (until <= now) rateLimitedUntil.delete(key);
    }
    const tokenKey = hashAccountKey(token);
    const limitedUntil = rateLimitedUntil.get(tokenKey);
    if (limitedUntil !== undefined && limitedUntil > now)
      throw rateLimitedError(limitedUntil - now);
    rateLimitedUntil.delete(tokenKey);

    const res = await fetchApi("https://api.anthropic.com/api/oauth/usage", {
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "anthropic-beta": CLAUDE_OAUTH_BETA,
      },
    });
    if (res.status === 401 || res.status === 403) return res.status;
    if (res.status === 429) {
      const waitMs = retryAfterMs(res.headers.get("retry-after"), now);
      if (waitMs !== null) rateLimitedUntil.set(tokenKey, now + waitMs);
      throw rateLimitedError(waitMs);
    }
    if (!res.ok) throw new Error(`Claude usage API returned ${res.status}`);
    return ClaudeUsageResponseSchema.parse(await res.json());
  }

  const credentials = await resolveClaudeCredentials(input, credentialLookup);
  if (!credentials) throw new Error("Claude login store no longer exists");
  const refreshedBy =
    input.route.store === "claude" || input.route.store === "keychain"
      ? "claude"
      : input.route.store;
  if (
    credentials.expires !== undefined &&
    credentials.expires <= (credentialLookup.now ?? Date.now)()
  )
    return unavailable({
      kind: "expired",
      expiresAt: new Date(credentials.expires).toISOString(),
      refreshedBy,
    });
  const profile = await cachedProfile(
    credentials.oauth.accessToken,
    (credentialLookup.now ?? Date.now)(),
  );
  if (profile && "status" in profile)
    return unavailable({ kind: "rejected", status: profile.status, refreshedBy });

  const { oauth } = credentials;
  const plan = buildClaudePlan(oauth.subscriptionType, oauth.rateLimitTier);
  const resp = await callClaudeApi(oauth.accessToken, (credentialLookup.now ?? Date.now)());

  if (typeof resp === "number") return unavailable({ kind: "rejected", status: resp, refreshedBy });

  const scoped = reconcileScopedLimits(
    legacyScopedLimits(resp),
    scopedLimitsFromResponse(resp.limits),
  );
  const windows = [...unscopedWindows(resp), ...scopedWindows(scoped)];

  if (windows.length === 0) {
    // The response parsed but described nothing. That silence is how the previous
    // shape change went unnoticed, so make it greppable. `warn` and not `debug`
    // because file logging defaults to `info`.
    console.warn("Claude usage response parsed but produced no windows");
  }

  const details: UsageDetail[] = [];
  const extraUsageEnabled = resp.extra_usage?.is_enabled;
  if (extraUsageEnabled !== undefined) {
    details.push({
      id: "extra_usage",
      label: "Extra usage",
      value: extraUsageEnabled ? "Enabled" : "Disabled",
    });
  }

  return {
    status: "available",
    planLabel: plan ?? undefined,
    windows,
    balances: [],
    details,
  };
}

// A 429 from the usage endpoint carries Retry-After, observed in the tens of minutes. Until it
// passes, a fetch (including a forced Refresh) answers from here instead of calling again.
const rateLimitedUntil = new Map<string, number>();

function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function rateLimitedError(waitMs: number | null): Error {
  const when = waitMs === null ? "later" : `in ${formatWait(waitMs)}`;
  return new Error(`Rate limited by Claude. Try again ${when}.`);
}

function formatWait(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.ceil(minutes / 60)}h`;
}

// The OAuth usage endpoint meters the active organization selected by the token.
type ClaudeIdentity = { key: string; label?: string } | { status: number };
const PROFILE_TTL_MS = 300_000;
const PROFILE_CACHE_LIMIT = 128;
const profileCache = new Map<string, { at: number; result: Promise<ClaudeIdentity> }>();

function cachedProfile(token: string, now: number): Promise<ClaudeIdentity> | undefined {
  pruneProfileCache(now);
  return profileCache.get(hashAccountKey(token))?.result;
}

function pruneProfileCache(now: number): void {
  for (const [key, entry] of profileCache) {
    if (now - entry.at >= PROFILE_TTL_MS) profileCache.delete(key);
  }
}

async function readProfile(
  token: string,
  fetchApi: typeof fetch,
  now: () => number,
): Promise<ClaudeIdentity> {
  const tokenHash = hashAccountKey(token);
  pruneProfileCache(now());
  const pending = profileCache.get(tokenHash);
  if (pending) return pending.result;
  while (profileCache.size >= PROFILE_CACHE_LIMIT) {
    const oldest = profileCache.keys().next().value;
    if (oldest === undefined) break;
    profileCache.delete(oldest);
  }
  const request = (async () => {
    const response = await fetchApi("https://api.anthropic.com/api/oauth/profile", {
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "anthropic-beta": CLAUDE_OAUTH_BETA,
      },
    });
    if (response.status === 401 || response.status === 403) return { status: response.status };
    if (!response.ok) throw new Error(`Claude profile API returned ${response.status}`);
    const profile = z
      .object({
        account: z.object({ uuid: z.string().min(1), email: z.string().optional() }),
        organization: z.object({ uuid: z.string().min(1) }),
      })
      .parse(await response.json());
    const account = profile.account;
    return {
      key: `${account.uuid}.${profile.organization.uuid}`,
      ...(account.email ? { label: account.email } : {}),
    };
  })();
  profileCache.set(tokenHash, { at: now(), result: request });
  try {
    return await request;
  } catch (error) {
    if (profileCache.get(tokenHash)?.result === request) profileCache.delete(tokenHash);
    throw error;
  }
}
