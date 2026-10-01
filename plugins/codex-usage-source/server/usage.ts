import { discoverOmp, piAuthPath, readHarness, readJson, type StoreLookup } from "./stores.js";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  balanceToneFromRemaining,
  toneFromUsedPct,
  windowFromUsedPct,
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
const windowSchema = z.object({ used_percent: number.optional(), reset_at: number.optional() });
const responseSchema = z.object({
  plan_type: z.string().optional(),
  email: z.string().optional(),
  rate_limit: z
    .object({ primary_window: windowSchema.nullish(), secondary_window: windowSchema.nullish() })
    .nullish(),
  code_review_rate_limit: z.object({ primary_window: windowSchema.nullish() }).nullish(),
  credits: z.object({ balance: number.optional() }).nullish(),
});

interface Auth {
  token: string;
  accountId?: string;
  idToken?: string;
  expires?: number;
}

export async function discover(lookup: StoreLookup = {}): Promise<CodexUsageInput[]> {
  const env = lookup.env ?? process.env;
  const home = lookup.home ?? homedir();
  const paths = [
    ...(env.CODEX_HOME ? [join(env.CODEX_HOME, "auth.json")] : []),
    join(home, ".codex", "auth.json"),
  ];
  const candidates: CodexUsageInput[] = [...new Set(paths)].map((path) => ({
    route: { store: "codex", path },
  }));
  candidates.push(
    {
      route: {
        store: "opencode",
        path: join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode", "auth.json"),
      },
    },
    { route: { store: "pi", path: piAuthPath(lookup) } },
    ...discoverOmp(lookup).map((route) => ({ route })),
  );
  const present: CodexUsageInput[] = [];
  for (const input of candidates) if (await readAuth(input, lookup)) present.push(input);
  return present;
}

export async function readAuth(
  input: CodexUsageInput,
  lookup: StoreLookup = {},
): Promise<Auth | null> {
  const route = input.route;
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

function usageWindow(
  spec: { id: string; label: string; shortLabel: string; summary?: boolean },
  value: z.infer<typeof windowSchema> | null | undefined,
): UsageWindow | null {
  if (!value) return null;
  const usedPct = value.used_percent ?? 0;
  return windowFromUsedPct({
    ...spec,
    utilizationPct: usedPct,
    resetsAt: value.reset_at != null ? new Date(value.reset_at * 1000).toISOString() : null,
    tone: toneFromUsedPct(usedPct),
  });
}

export async function fetchUsage(
  input: CodexUsageInput,
  fetchApi: typeof fetch = fetch,
  lookup: StoreLookup = {},
): Promise<UsageReport> {
  const auth = await readAuth(input, lookup);
  if (!auth || (auth.expires !== undefined && auth.expires <= (lookup.now ?? Date.now)()))
    return { status: "unavailable", windows: [] };
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
    return { status: "unavailable", windows: [] };
  if (!response.ok) throw new Error(`Codex usage API returned ${response.status}`);
  const text = await response.text();
  if (text.trim().startsWith("<")) return { status: "unavailable", windows: [] };
  const usage = responseSchema.parse(JSON.parse(text));
  const windows = [
    usageWindow(
      { id: "session", label: "Session", shortLabel: "5h", summary: true },
      usage.rate_limit?.primary_window,
    ),
    usageWindow(
      { id: "weekly", label: "Weekly", shortLabel: "wk", summary: true },
      usage.rate_limit?.secondary_window,
    ),
    usageWindow(
      { id: "code_review", label: "Code review", shortLabel: "review" },
      usage.code_review_rate_limit?.primary_window,
    ),
  ].filter((window): window is UsageWindow => window !== null);
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

export async function identify(input: CodexUsageInput, lookup: StoreLookup = {}) {
  const auth = await readAuth(input, lookup);
  if (!auth) return null;
  const access = jwtClaims(auth.token);
  const id = jwtClaims(auth.idToken);
  const accessAuth = claimObject(access, "https://api.openai.com/auth");
  const idAuth = claimObject(id, "https://api.openai.com/auth");
  const key =
    auth.accountId ??
    claimString(accessAuth?.["chatgpt_account_id"]) ??
    claimString(access?.["chatgpt_account_id"]) ??
    claimString(idAuth?.["chatgpt_account_id"]);
  if (!key) return null;
  const label =
    claimString(claimObject(access, "https://api.openai.com/profile")?.["email"]) ??
    claimString(access?.["email"]) ??
    claimString(claimObject(id, "https://api.openai.com/profile")?.["email"]) ??
    claimString(id?.["email"]);
  return { key, ...(label ? { label } : {}) };
}
