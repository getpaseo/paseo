import type { UsageInput } from "../shared/input.js";
import { z } from "zod";
import {
  toneFromUsedPct,
  unavailable,
  windowFromReportedDuration,
  type UsageAccount,
  type UsageDetail,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";

const ApiNumberSchema = z.coerce.number().finite();
const ApiOptionalStringSchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.coerce.string().optional(),
);

const ZAI_SUBSCRIPTION_URL = "https://api.z.ai/api/biz/subscription/list";
const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

// Both endpoints answer HTTP 200 even when they fail (an invalid key is
// `{"code":1000,"msg":"Authentication Failed","success":false}`), so the envelope
// carries the real outcome.
const ZaiEnvelopeSchema = z.object({
  success: z.boolean().optional(),
  code: ApiNumberSchema.nullish(),
  msg: ApiOptionalStringSchema,
});

const ZaiSubscriptionSchema = z.object({
  productName: ApiOptionalStringSchema,
  status: ApiOptionalStringSchema,
});

const ZaiSubscriptionResponseSchema = ZaiEnvelopeSchema.extend({
  data: z.array(ZaiSubscriptionSchema).optional(),
});

const ZaiLimitSchema = z.object({
  type: ApiOptionalStringSchema,
  percentage: ApiNumberSchema.nullish(),
  nextResetTime: ApiNumberSchema.nullish(),
  unit: ApiNumberSchema.nullish(),
  number: ApiNumberSchema.nullish(),
});

const ZaiQuotaSchema = z.object({
  limits: z.array(ZaiLimitSchema).optional(),
  level: ApiOptionalStringSchema,
});

const ZaiQuotaResponseSchema = ZaiEnvelopeSchema.extend({
  data: ZaiQuotaSchema.optional(),
});

type ZaiSubscription = z.infer<typeof ZaiSubscriptionSchema>;
type ZaiLimit = z.infer<typeof ZaiLimitSchema>;
type ZaiQuota = z.infer<typeof ZaiQuotaSchema>;

// A limit's window is a time unit plus a count (unit 3, number 5 = "every 5 hours").
// z.ai does not document the enum; these values match what every other client of this
// endpoint has observed, and anything else is an unknown window rather than a guess.
const ZAI_WINDOW_UNIT_HOURS = 3;
const ZAI_WINDOW_UNIT_DAYS = 4;
const ZAI_WINDOW_UNIT_MONTHS = 5;
const ZAI_WINDOW_UNIT_WEEK = 6;

// Credits (current plans) and tokens (older plans) are the coding quota itself and use
// the shared window names. Anything else, such as the per-feature request limits, is a
// separate quota and is scoped so it never reads as the coding window.
const ZAI_CODING_LIMIT_TYPES = new Set(["CREDIT_LIMIT", "TOKENS_LIMIT"]);
const ZAI_LIMIT_SCOPE: Record<string, { id: string; label: string }> = {
  TIME_LIMIT: { id: "requests", label: "Requests" },
};

function zaiDurationSeconds(limit: ZaiLimit): number | null {
  const count = typeof limit.number === "number" && limit.number > 0 ? limit.number : 1;
  switch (limit.unit) {
    case ZAI_WINDOW_UNIT_HOURS:
      return count * 3600;
    case ZAI_WINDOW_UNIT_DAYS:
      return count * 86400;
    case ZAI_WINDOW_UNIT_WEEK:
      return 604800;
    default:
      return null;
  }
}

// A month has no fixed length, so it is named here rather than derived from a duration.
function zaiUnknownWindowName(limit: ZaiLimit): { id: string; label: string; shortLabel: string } {
  if (limit.unit === ZAI_WINDOW_UNIT_MONTHS) {
    return { id: "monthly", label: "Monthly", shortLabel: "mo" };
  }
  return { id: "quota", label: "Quota", shortLabel: "" };
}

function zaiLimitScope(limit: ZaiLimit): { id: string; label: string } | undefined {
  if (!limit.type || ZAI_CODING_LIMIT_TYPES.has(limit.type)) return undefined;
  return ZAI_LIMIT_SCOPE[limit.type] ?? { id: limit.type.toLowerCase(), label: limit.type };
}

// The client uses window ids as React keys, so two limits on the same window (z.ai
// reports separate request limits per feature set) must not collide.
function uniqueWindowId(input: { baseId: string; seenIds: Set<string> }): string {
  let id = input.baseId;
  let suffix = 2;
  while (input.seenIds.has(id)) {
    id = `${input.baseId}_${suffix}`;
    suffix += 1;
  }
  input.seenIds.add(id);
  return id;
}

function zaiWindowFromLimit(input: { limit: ZaiLimit; seenIds: Set<string> }): UsageWindow | null {
  const { limit, seenIds } = input;
  if (typeof limit.percentage !== "number") return null;
  const scope = zaiLimitScope(limit);
  const window = windowFromReportedDuration({
    durationSeconds: zaiDurationSeconds(limit),
    scope,
    unknown: zaiUnknownWindowName(limit),
    utilizationPct: limit.percentage,
    resetsAt:
      typeof limit.nextResetTime === "number" ? new Date(limit.nextResetTime).toISOString() : null,
    summary: !scope,
    tone: toneFromUsedPct(limit.percentage),
  });
  return { ...window, id: uniqueWindowId({ baseId: window.id, seenIds }) };
}

function zaiPlanLabel(input: {
  subscription: ZaiSubscription | null;
  quota: ZaiQuota;
}): string | undefined {
  if (input.subscription?.productName) return input.subscription.productName;
  const level = input.quota.level;
  if (!level) return undefined;
  return level.charAt(0).toUpperCase() + level.slice(1);
}

// Z.ai's error-code table (https://docs.z.ai/api-reference/api-code) documents these as
// HTTP 401: authentication failed, missing credentials, expired token, two-factor
// authentication required. The usage endpoints deliver them inside an HTTP 200 envelope,
// so the report carries the documented 401 rather than the transport's 200.
const ZAI_AUTH_FAILURE_CODES = new Set([1000, 1001, 1003, 1005]);

// undici reports network failures as a TypeError and AbortSignal.timeout as a
// DOMException named TimeoutError (AbortError on an externally aborted signal). Only
// these are safe to swallow for enrichment data; anything else — programming errors —
// must propagate.
function isZaiTransportError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  return err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
}

function fetchZai(input: { fetchApi: typeof fetch; url: string; token: string }) {
  return input.fetchApi(input.url, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${input.token}`,
      Accept: "application/json",
    },
  });
}

interface ZaiSubscriptionLookup {
  subscription: ZaiSubscription | null;
  /** The endpoint answered with something this parser does not understand. */
  unreadable: boolean;
}

const NO_SUBSCRIPTION: ZaiSubscriptionLookup = { subscription: null, unreadable: false };
const UNREADABLE_SUBSCRIPTION: ZaiSubscriptionLookup = { subscription: null, unreadable: true };

async function fetchSubscription(input: {
  fetchApi: typeof fetch;
  token: string;
}): Promise<ZaiSubscriptionLookup> {
  const res = await fetchZai({ ...input, url: ZAI_SUBSCRIPTION_URL });
  if (!res.ok) return NO_SUBSCRIPTION;
  // Unreadable subscription data must not discard the quota bars, which come from a
  // separate response; it is flagged on the report instead of failing it.
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    if (err instanceof SyntaxError) return UNREADABLE_SUBSCRIPTION;
    throw err;
  }
  const resp = ZaiSubscriptionResponseSchema.safeParse(body);
  if (!resp.success) return UNREADABLE_SUBSCRIPTION;
  if (resp.data.success === false) return NO_SUBSCRIPTION;
  return { subscription: resp.data.data?.[0] ?? null, unreadable: false };
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  const token = process.env[input.locator];
  if (!token) throw new Error("Z.ai login store no longer exists");

  const [{ subscription, unreadable }, res] = await Promise.all([
    // Subscription only enriches the plan label; an unreachable endpoint must
    // never take the quota bars down. Anything else rethrows.
    fetchSubscription({ fetchApi, token }).catch((err: unknown) => {
      if (!isZaiTransportError(err)) throw err;
      return NO_SUBSCRIPTION;
    }),
    fetchZai({ fetchApi, url: ZAI_QUOTA_URL, token }),
  ]);

  if (res.status === 401 || res.status === 403)
    return unavailable({ kind: "rejected", status: res.status });
  if (!res.ok) throw new Error(`Z.ai usage API returned ${res.status}`);

  const resp = ZaiQuotaResponseSchema.parse(await res.json());
  if (resp.success === false) {
    if (typeof resp.code === "number" && ZAI_AUTH_FAILURE_CODES.has(resp.code))
      return unavailable({ kind: "rejected", status: 401 });
    throw new Error(`Z.ai usage API rejected the request: ${resp.msg ?? `code ${resp.code}`}`);
  }
  // The usage bars only ever come from quota — without it, "available" with no
  // windows would render an empty card.
  const quota = resp.data;
  if (!quota) return unavailable({ kind: "no_quota", detail: "No active coding plan" });

  const seenIds = new Set<string>();
  const windows: UsageWindow[] = [];
  for (const limit of quota.limits ?? []) {
    const window = zaiWindowFromLimit({ limit, seenIds });
    if (window) windows.push(window);
  }

  const details: UsageDetail[] = [];
  if (subscription?.status) {
    details.push({ id: "status", label: "Status", value: subscription.status });
  }
  if (unreadable) {
    details.push({
      id: "subscription",
      label: "Plan details",
      value: "Unexpected response from Z.ai",
      tone: "warning",
    });
  }

  return {
    status: "available",
    planLabel: zaiPlanLabel({ subscription, quota }),
    windows,
    balances: [],
    details,
  };
}

export async function discover(): Promise<UsageAccount[]> {
  for (const locator of ["ZAI_API_KEY", "GLM_API_KEY"]) {
    if (process.env[locator]) return [{ key: "default", input: { store: "env", locator } }];
  }
  return [];
}
