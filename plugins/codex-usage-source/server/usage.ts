import {
  discoverOmp,
  opencodeStorePaths,
  piAuthPath,
  readHarness,
  readJson,
  readOpencodeOauth,
  type StoreLookup,
} from "./stores.js";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  balanceToneFromRemaining,
  hashAccountKey,
  unavailable,
  type UsageAccount,
  type UsageScope,
  toneFromUsedPct,
  windowFromReportedDuration,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import type { CodexUsageInput } from "../shared/input.js";

const authSchema = z.object({
  tokens: z
    .object({
      access_token: z.string().optional(),
      account_id: z.string().optional(),
      id_token: z.string().optional(),
    })
    .optional(),
});
const number = z.coerce.number().finite();
const windowSchema = z.object({
  used_percent: number.optional(),
  reset_at: number.optional(),
  limit_window_seconds: number.nullish(),
});
const rateLimitSchema = z.object({
  primary_window: windowSchema.nullish(),
  secondary_window: windowSchema.nullish(),
});
const spendControlSchema = z.object({
  individual_limit: z
    .object({
      used_percent: number.nullish(),
      remaining_percent: number.nullish(),
      reset_at: number.nullish(),
    })
    .nullish(),
});
const responseSchema = z.object({
  plan_type: z.string().optional(),
  email: z.string().optional(),
  rate_limit: rateLimitSchema.nullish(),
  additional_rate_limits: z
    .array(
      z.object({
        limit_name: z.string().optional(),
        metered_feature: z.string().optional(),
        rate_limit: rateLimitSchema.nullish(),
      }),
    )
    .nullish(),
  code_review_rate_limit: rateLimitSchema.nullish(),
  spend_control: spendControlSchema.nullish(),
  credits: z.object({ balance: number.optional() }).nullish(),
});

interface Auth {
  token: string;
  accountId?: string;
  idToken?: string;
  expires?: number;
}

export async function discover(
  scope: UsageScope,
  lookup: StoreLookup = {},
): Promise<UsageAccount[]> {
  if (scope.kind === "session")
    lookup = {
      ...lookup,
      env: scope.env,
      home: scope.env.HOME || scope.env.USERPROFILE || homedir(),
    };
  const candidates =
    scope.kind === "global" ? globalRoutes(scope, lookup) : sessionRoutes(scope, lookup);
  const present: UsageAccount[] = [];
  for (const input of candidates) {
    const auth = await readAuth(input, lookup);
    if (auth)
      present.push({
        ...accountIdentity(auth, input),
        harness: harnessLabel(input),
        provider: providerId(input.route.store),
        input,
      });
  }
  return present;
}

function globalRoutes(
  scope: Extract<UsageScope, { kind: "global" }>,
  lookup: StoreLookup,
): CodexUsageInput[] {
  const env = lookup.env ?? process.env;
  const home = lookup.home ?? homedir();
  const codexEnv = scope.launch ? { ...lookup.env, ...scope.launch.env } : env;
  const codexHome = scope.launch ? codexEnv.HOME || codexEnv.USERPROFILE || home : home;
  const candidates: CodexUsageInput[] = [];
  if (!shouldSuppressLocalCodexAuth(codexEnv, scope.launch)) {
    const paths = [
      ...(codexEnv.CODEX_HOME ? [join(codexEnv.CODEX_HOME, "auth.json")] : []),
      join(codexHome, ".codex", "auth.json"),
    ];
    for (const path of new Set(paths)) {
      candidates.push({ route: { store: "codex", path } });
    }
  }
  candidates.push(...opencodeRoutes(env, home, lookup));
  candidates.push(
    { route: { store: "pi", path: piAuthPath(lookup) } },
    ...discoverOmp(lookup).map((route) => ({ route })),
  );
  return candidates;
}

/**
 * OpenCode v2 stores its logins in a database and leaves the v1 credential file
 * untouched, so a file login can be stale while the database login is current.
 * The database wins whenever it holds an OpenAI login; the file stays the
 * source for v1 installations that have no such database.
 */
function opencodeRoutes(
  env: NodeJS.ProcessEnv,
  home: string,
  lookup: StoreLookup,
): CodexUsageInput[] {
  const { file, database } = opencodeStorePaths(env, home);
  const logins = readOpencodeOauth(database, lookup);
  if (!logins.length) return [{ route: { store: "opencode", path: file } }];
  return logins.map((login) => ({
    route: { store: "opencode-db", path: database, credentialId: login.id },
  }));
}

function sessionRoutes(
  scope: Extract<UsageScope, { kind: "session" }>,
  lookup: StoreLookup,
): CodexUsageInput[] {
  const env = scope.env;
  const home = lookup.home ?? homedir();
  if (scope.provider === "codex") {
    if (shouldSuppressLocalCodexAuth(env, scope.launch)) return [];
    return [
      {
        route: { store: "codex", path: join(env.CODEX_HOME || join(home, ".codex"), "auth.json") },
      },
    ];
  }
  if (!scope.model?.startsWith("openai/")) return [];
  if (scope.provider === "pi") return [{ route: { store: "pi", path: piAuthPath(lookup) } }];
  if (scope.provider === "omp") return discoverOmp(lookup).map((route) => ({ route }));
  if (scope.provider === "opencode")
    return opencodeRoutes(scope.env, lookup.home ?? homedir(), lookup);
  return [];
}

function hasNonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isWrapperLaunch(
  launch: UsageScope["launch"] | undefined,
  expectedBinary: string,
): boolean {
  if (!launch) return false;
  if (launch.args.length > 0) return true;
  const command = launch.command.trim();
  if (!command) return false;
  const base = command.replaceAll("\\", "/").split("/").pop()?.toLowerCase() ?? "";
  const stem = base.replace(/\.(?:exe|cmd|bat|ps1)$/, "");
  return stem !== expectedBinary;
}

/**
 * Suppresses reading default local `~/.codex/auth.json` credentials when the provider or session
 * authenticates through `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, a custom `OPENAI_BASE_URL`, or a
 * wrapper command. Plain `OPENAI_API_KEY` is intentionally ignored because Codex login does not
 * select an account from `OPENAI_API_KEY` (custom OpenAI-compatible providers only opt into it
 * alongside `OPENAI_BASE_URL`), so exporting `OPENAI_API_KEY` in a shell must not hide a ChatGPT
 * login in `auth.json`. Custom `CODEX_HOME` profiles on the default CLI binary are unaffected.
 */
function shouldSuppressLocalCodexAuth(
  env: NodeJS.ProcessEnv,
  launch: UsageScope["launch"] | undefined,
): boolean {
  if (isWrapperLaunch(launch, "codex")) return true;
  return (
    hasNonEmpty(env.CODEX_API_KEY) ||
    hasNonEmpty(env.CODEX_ACCESS_TOKEN) ||
    hasNonEmpty(env.OPENAI_BASE_URL)
  );
}

export async function readAuth(
  input: CodexUsageInput,
  lookup: StoreLookup = {},
): Promise<Auth | null> {
  const route = input.route;
  if (route.store === "opencode-db") {
    const login = readOpencodeOauth(route.path, lookup).find(
      (candidate) => candidate.id === route.credentialId,
    );
    return login
      ? { token: login.access, accountId: login.accountId, expires: login.expires }
      : null;
  }
  if (route.store !== "codex") {
    const oauth = await readHarness(route, lookup);
    return oauth
      ? { token: oauth.access, accountId: oauth.accountId, expires: oauth.expires }
      : null;
  }
  const auth = authSchema.safeParse(await readJson(route.path));
  if (!auth.success || !auth.data.tokens?.access_token) return null;
  return {
    token: auth.data.tokens.access_token,
    accountId: auth.data.tokens.account_id,
    idToken: auth.data.tokens.id_token,
  };
}

function usageWindows({
  rateLimit,
  scope,
  summary = false,
}: {
  rateLimit: z.infer<typeof rateLimitSchema> | null | undefined;
  scope?: { id: string; label: string };
  summary?: boolean;
}): UsageWindow[] {
  if (!rateLimit) return [];
  return (["primary_window", "secondary_window"] as const).flatMap((slot) => {
    const value = rateLimit[slot];
    if (!value) return [];
    const primary = slot === "primary_window";
    // Codex does not always report a length. A slot is then only an unknown limit,
    // never evidence of a five-hour or weekly period.
    return [
      windowFromReportedDuration({
        durationSeconds: value.limit_window_seconds ?? null,
        unknown: {
          id: primary ? "unknown_primary" : "unknown_secondary",
          label: primary ? "Primary limit" : "Secondary limit",
          shortLabel: "",
        },
        scope,
        summary,
        utilizationPct: value.used_percent,
        resetsAt: value.reset_at != null ? new Date(value.reset_at * 1000).toISOString() : null,
        tone: toneFromUsedPct(value.used_percent),
      }),
    ];
  });
}

export async function fetchUsage(
  input: CodexUsageInput,
  fetchApi: typeof fetch = fetch,
  lookup: StoreLookup = {},
): Promise<UsageReport> {
  const auth = await readAuth(input, lookup);
  if (!auth) throw new Error("Codex login store no longer exists");
  const refreshedBy = providerId(input.route.store);
  if (auth.expires !== undefined && auth.expires <= (lookup.now ?? Date.now)())
    return unavailable({
      kind: "expired",
      expiresAt: new Date(auth.expires).toISOString(),
      refreshedBy,
    });
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
  const response = await fetchApi("https://chatgpt.com/backend-api/wham/usage", {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403)
    return unavailable({ kind: "rejected", status: response.status, refreshedBy });
  if (!response.ok) throw new Error(`Codex usage API returned ${response.status}`);
  const text = await response.text();
  if (text.trim().startsWith("<")) throw new Error("Codex usage API returned HTML");
  const usage = responseSchema.parse(JSON.parse(text));
  const windows = [
    ...usageWindows({ rateLimit: usage.rate_limit, summary: true }),
    ...(usage.additional_rate_limits ?? []).flatMap((limit) => {
      const identity = limit.metered_feature || limit.limit_name;
      if (!identity) return []; // An unnamed limit has no stable quota identity.
      return usageWindows({
        rateLimit: limit.rate_limit,
        scope: {
          id: `limit:${encodeURIComponent(identity)}`,
          label: limit.limit_name || identity,
        },
      });
    }),
    ...(usage.spend_control?.individual_limit
      ? (() => {
          const limit = usage.spend_control.individual_limit;
          const usedPct =
            limit.used_percent ??
            (limit.remaining_percent != null ? 100 - limit.remaining_percent : undefined);
          if (usedPct === undefined) return [];
          return [
            {
              id: "individual_limit",
              label: "Individual spend limit",
              summary: true,
              usedPct,
              remainingPct: limit.remaining_percent ?? Math.max(0, 100 - usedPct),
              resetsAt:
                limit.reset_at != null ? new Date(limit.reset_at * 1000).toISOString() : null,
              tone: toneFromUsedPct(usedPct),
            },
          ];
        })()
      : []),
    ...usageWindows({
      rateLimit: usage.code_review_rate_limit,
      scope: { id: "code_review", label: "Code review" },
    }),
  ];
  const balance = usage.credits?.balance;
  return {
    status: "available",
    planLabel: usage.plan_type,
    windows,
    balances:
      balance === undefined
        ? []
        : [
            {
              id: "credits",
              label: "Credits",
              remaining: balance,
              unit: "credits",
              tone: balanceToneFromRemaining(balance),
            },
          ],
    details: [],
  };
}

/** JWT claims are decoded locally; no token or email becomes an account key. */
function jwtClaims(token: string | undefined): Record<string, unknown> | null {
  try {
    const payload = token?.split(".")[1];
    return payload
      ? (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function claimObject(
  claims: Record<string, unknown> | null,
  name: string,
): Record<string, unknown> | null {
  const value = claims?.[name];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function claimString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function accountIdentity(auth: Auth, input: CodexUsageInput): { key: string; label?: string } {
  const access = jwtClaims(auth.token);
  const id = jwtClaims(auth.idToken);
  const accessAuth = claimObject(access, "https://api.openai.com/auth");
  const idAuth = claimObject(id, "https://api.openai.com/auth");
  const key =
    auth.accountId ??
    claimString(accessAuth?.["chatgpt_account_id"]) ??
    claimString(access?.["chatgpt_account_id"]) ??
    claimString(idAuth?.["chatgpt_account_id"]);

  const label =
    claimString(claimObject(access, "https://api.openai.com/profile")?.["email"]) ??
    claimString(access?.["email"]) ??
    claimString(claimObject(id, "https://api.openai.com/profile")?.["email"]) ??
    claimString(id?.["email"]);
  return { key: key ?? hashAccountKey(JSON.stringify(input.route)), ...(label ? { label } : {}) };
}

function harnessLabel(input: CodexUsageInput): string {
  const labels = {
    codex: "Codex",
    opencode: "OpenCode",
    "opencode-db": "OpenCode",
    pi: "Pi",
    omp: "OMP",
  };
  return labels[input.route.store];
}

/** The canonical provider and CLI behind each credential store. */
function providerId(store: CodexUsageInput["route"]["store"]): string {
  return store === "opencode-db" ? "opencode" : store;
}
