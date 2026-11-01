import { z } from "zod";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageAccount,
  type UsageBalance,
  type UsageDetail,
  type UsageReport,
  type UsageScope,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import type { UsageInput } from "../shared/input.js";
import {
  factoryDir,
  keyStores,
  readLogin,
  tokenClaims,
  type FactoryCredentials,
  type StoreLookup,
} from "./stores.js";

const API_BASE_URL = "https://api.factory.ai";
const API_BASE_URL_EU = "https://api.eu.factory.ai";
const LIMITS_PATH = "/api/billing/limits";
const ORG_HEADER = "X-Factory-Org-Id";
const API_KEY_VARIABLE = "FACTORY_API_KEY";
const HARNESS = "Droid";

const bucketSchema = z.object({
  usedPercent: z.number().finite(),
  windowEnd: z.string().nullish(),
});
const poolSchema = z.object({
  fiveHour: bucketSchema,
  weekly: bucketSchema,
  monthly: bucketSchema,
});
const responseSchema = z.object({
  limits: z.object({ standard: poolSchema.nullish(), core: poolSchema.nullish() }).nullish(),
  extraUsageBalanceCents: z.number().finite().nullish(),
  extraUsageAllowed: z.boolean().nullish(),
  overagePreference: z.string().nullish(),
});
type Pool = z.infer<typeof poolSchema>;
type Bucket = z.infer<typeof bucketSchema>;

export interface FetchLookup extends StoreLookup {
  now?: () => number;
}

export async function discover(
  scope: UsageScope,
  lookup: StoreLookup = {},
): Promise<UsageAccount[]> {
  // Droid runs as a generic ACP agent, which reports no usage provider to match a session on.
  if (scope.kind === "session") return [];
  const env = lookup.env ?? process.env;
  const accounts: UsageAccount[] = [];
  if (env[API_KEY_VARIABLE]?.trim())
    accounts.push({
      key: API_KEY_VARIABLE,
      harness: HARNESS,
      input: { store: "env", locator: API_KEY_VARIABLE },
    });
  const dir = factoryDir(env);
  for (const keyStore of keyStores(lookup.platform ?? process.platform)) {
    const input = { store: "login" as const, factoryDir: dir, keyStore };
    const credentials = await readLogin(input, lookup);
    if (!credentials) continue;
    // On-prem deployments serve billing from their own host, which this source does not reach.
    if (credentials.isOnPrem) break;
    const claims = tokenClaims(credentials.accessToken);
    const identity = claims.subject
      ? `${claims.subject}:${credentials.organizationId ?? claims.organizationId ?? ""}`
      : dir;
    accounts.push({ key: hashAccountKey(identity), harness: HARNESS, input });
    // The CLI uses the first readable store; later stores hold an older login.
    break;
  }
  return accounts;
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
  lookup: FetchLookup = {},
): Promise<UsageReport> {
  const env = lookup.env ?? process.env;
  const now = (lookup.now ?? Date.now)();
  let credentials: FactoryCredentials;
  if (input.store === "env") {
    const apiKey = env[input.locator]?.trim();
    if (!apiKey) throw new Error(`${input.locator} is no longer set`);
    credentials = { accessToken: apiKey, organizationId: null, region: null, isOnPrem: false };
  } else {
    const login = await readLogin(input, lookup);
    if (!login) throw new Error("Factory login store no longer exists");
    credentials = login;
    // Droid refreshes its own token while it runs; refreshing here would rotate the CLI's
    // refresh token and sign it out.
    const { expiresAt } = tokenClaims(login.accessToken);
    if (expiresAt !== null && expiresAt * 1000 <= now)
      return unavailable({
        kind: "expired",
        expiresAt: new Date(expiresAt * 1000).toISOString(),
        refreshedBy: "droid",
      });
  }

  const response = await fetchApi(`${apiBaseUrl(env, credentials.region)}${LIMITS_PATH}`, {
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: "application/json",
      ...(credentials.organizationId ? { [ORG_HEADER]: credentials.organizationId } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403)
    return unavailable({ kind: "rejected", status: response.status, refreshedBy: "droid" });
  if (!response.ok) throw new Error(`Factory usage API returned ${response.status}`);
  return reportFromPayload(await response.json(), now);
}

function apiBaseUrl(env: NodeJS.ProcessEnv, region: string | null): string {
  const configured = env.FACTORY_API_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return region === "eu" ? API_BASE_URL_EU : API_BASE_URL;
}

export function reportFromPayload(payload: unknown, now: number): UsageReport {
  const data = responseSchema.parse(payload);
  const standard = data.limits?.standard;
  if (!standard)
    return unavailable({ kind: "no_quota", detail: "This Factory plan reports no usage limits." });
  const windows = [
    ...poolWindows({ pool: standard, scope: null, now }),
    ...(data.limits?.core ? poolWindows({ pool: data.limits.core, scope: CORE_SCOPE, now }) : []),
  ];
  return {
    status: "available",
    windows,
    balances: extraUsageBalances(data),
    details: overageDetails(data.overagePreference),
  };
}

const CORE_SCOPE = { id: "core", label: "Droid Core", shortLabel: "Core" };

const POOL_WINDOWS = [
  { field: "fiveHour", id: "five_hour", label: "5-hour", shortLabel: "5h" },
  { field: "weekly", id: "weekly", label: "Weekly", shortLabel: "wk" },
  { field: "monthly", id: "monthly", label: "Monthly", shortLabel: "mo" },
] as const;

function poolWindows(input: {
  pool: Pool;
  scope: typeof CORE_SCOPE | null;
  now: number;
}): UsageWindow[] {
  const { pool, scope, now } = input;
  return POOL_WINDOWS.map((spec) => {
    const bucket = pool[spec.field];
    // The API keeps a finished window's percent until the next request opens a new window;
    // the CLI treats it as rolled over.
    const ended = hasEnded(bucket, now);
    const usedPct = ended ? 0 : bucket.usedPercent;
    return windowFromUsedPct({
      id: scope ? `${scope.id}:${spec.id}` : spec.id,
      label: scope ? `${scope.label} · ${spec.label}` : spec.label,
      shortLabel: scope ? `${scope.shortLabel} ${spec.shortLabel}` : spec.shortLabel,
      summary: scope === null && spec.field !== "monthly",
      utilizationPct: usedPct,
      resetsAt: ended ? null : bucket.windowEnd,
      tone: toneFromUsedPct(usedPct),
    });
  });
}

function hasEnded(bucket: Bucket, now: number): boolean {
  if (!bucket.windowEnd) return false;
  const end = Date.parse(bucket.windowEnd);
  return Number.isFinite(end) && end < now;
}

function extraUsageBalances(data: z.infer<typeof responseSchema>): UsageBalance[] {
  const cents = data.extraUsageBalanceCents ?? 0;
  if (data.extraUsageAllowed !== true && cents <= 0) return [];
  return [
    {
      id: "extra_usage",
      label: "Extra usage",
      remaining: cents / 100,
      unit: "usd",
      tone: cents > 0 ? "ok" : "default",
    },
  ];
}

const OVERAGE_LABELS: Record<string, string> = {
  droidCore: "Switch to Droid Core",
  extraUsage: "Use extra usage",
};

function overageDetails(preference: string | null | undefined): UsageDetail[] {
  const value = preference ? OVERAGE_LABELS[preference] : undefined;
  return value ? [{ id: "overage", label: "When Standard runs out", value }] : [];
}
