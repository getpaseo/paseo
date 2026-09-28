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
  ApiOptionalStringSchema,
  fetchProviderApi,
  toIsoStringOrNull,
  toneFromUsedPct,
  unavailableUsage,
  windowFromUsedPct,
} from "../usage.js";

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
// endpoint has observed, and anything else gets a generic label rather than a guess.
const ZAI_WINDOW_UNIT_HOURS = 3;
const ZAI_WINDOW_UNIT_DAYS = 4;
const ZAI_WINDOW_UNIT_MONTHS = 5;
const ZAI_WINDOW_UNIT_WEEK = 6;

const ZAI_LIMIT_KIND_LABEL: Record<string, string> = {
  CREDIT_LIMIT: "Credits",
  TOKENS_LIMIT: "Tokens",
  TIME_LIMIT: "Requests",
};

interface ZaiWindowBase {
  id: string;
  label: string;
}

function zaiWindowBase(limit: ZaiLimit): ZaiWindowBase {
  const count = typeof limit.number === "number" && limit.number > 0 ? limit.number : 1;
  switch (limit.unit) {
    case ZAI_WINDOW_UNIT_HOURS:
      return { id: `${count}h`, label: count === 1 ? "Hourly" : `${count}-hour` };
    case ZAI_WINDOW_UNIT_DAYS:
      return { id: `${count}d`, label: count === 1 ? "Daily" : `${count}-day` };
    case ZAI_WINDOW_UNIT_MONTHS:
      return { id: `${count}mo`, label: count === 1 ? "Monthly" : `${count}-month` };
    case ZAI_WINDOW_UNIT_WEEK:
      return { id: "1w", label: "Weekly" };
    default:
      return { id: "quota", label: "Quota" };
  }
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

function zaiWindowFromLimit(input: {
  limit: ZaiLimit;
  seenIds: Set<string>;
}): ProviderUsageWindow | null {
  const { limit, seenIds } = input;
  if (typeof limit.percentage !== "number") return null;
  const base = zaiWindowBase(limit);
  const kind = limit.type ? ZAI_LIMIT_KIND_LABEL[limit.type] : undefined;
  return windowFromUsedPct({
    id: uniqueWindowId({ baseId: kind ? `${base.id}_${kind.toLowerCase()}` : base.id, seenIds }),
    label: kind ? `${base.label} ${kind}` : base.label,
    utilizationPct: limit.percentage,
    resetsAt:
      typeof limit.nextResetTime === "number" ? toIsoStringOrNull(limit.nextResetTime) : null,
    tone: toneFromUsedPct(limit.percentage),
  });
}

function zaiPlanLabel(input: {
  subscription: ZaiSubscription | null;
  quota: ZaiQuota;
}): string | null {
  if (input.subscription?.productName) return input.subscription.productName;
  const level = input.quota.level;
  if (!level) return null;
  return level.charAt(0).toUpperCase() + level.slice(1);
}

// undici reports network failures as a TypeError and fetchProviderApi's
// AbortSignal.timeout as a DOMException named TimeoutError (AbortError on an
// externally aborted signal). Only these are safe to swallow for enrichment
// data; anything else — schema drift, programming errors — must propagate.
function isZaiTransportError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  return err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
}

interface ZaiQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
}

export class ZaiQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "zai";
  readonly displayName = "Z.ai";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;

  constructor(options: ZaiQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const token = process.env["ZAI_API_KEY"] || process.env["GLM_API_KEY"];
    if (!token) return unavailableUsage(this);

    const [subscription, quota] = await Promise.all([
      // Subscription only enriches the plan label; an unreachable endpoint must
      // never take the quota bars down. Everything else rethrows.
      this.fetchSubscription(token).catch((err: unknown) => {
        if (!isZaiTransportError(err)) throw err;
        this.logger.debug({ err }, "Z.ai subscription fetch failed");
        return null;
      }),
      this.fetchQuota(token),
    ]);

    // The usage bars only ever come from quota — without it, "available" with no
    // windows would render the same empty card this provider exists to fix.
    if (!quota) return unavailableUsage(this);

    const details: ProviderUsageDetail[] = [];
    if (subscription?.status) {
      details.push({ id: "status", label: "Status", value: subscription.status });
    }

    const seenWindowIds = new Set<string>();
    const windows: ProviderUsageWindow[] = [];
    for (const limit of quota.limits ?? []) {
      const window = zaiWindowFromLimit({ limit, seenIds: seenWindowIds });
      if (window) windows.push(window);
    }
    if (windows.length === 0) {
      this.logger.warn("Z.ai quota response parsed but produced no windows");
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: zaiPlanLabel({ subscription, quota }),
      windows,
      balances: [],
      details,
      error: null,
    };
  }

  private fetchJson(input: { url: string; token: string }): Promise<Response> {
    return fetchProviderApi(this.fetchApi, input.url, {
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: "application/json",
      },
    });
  }

  private async fetchSubscription(token: string): Promise<ZaiSubscription | null> {
    const res = await this.fetchJson({ url: "https://api.z.ai/api/biz/subscription/list", token });
    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Z.ai subscription fetch failed");
      return null;
    }

    const resp = ZaiSubscriptionResponseSchema.parse(await res.json());
    if (resp.success === false) {
      this.logger.debug(
        { code: resp.code, message: resp.msg },
        "Z.ai subscription request rejected",
      );
      return null;
    }
    return resp.data?.[0] ?? null;
  }

  private async fetchQuota(token: string): Promise<ZaiQuota | null> {
    const res = await this.fetchJson({
      url: "https://api.z.ai/api/monitor/usage/quota/limit",
      token,
    });
    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Z.ai quota fetch failed");
      return null;
    }

    const resp = ZaiQuotaResponseSchema.parse(await res.json());
    if (resp.success === false) {
      this.logger.debug({ code: resp.code, message: resp.msg }, "Z.ai quota request rejected");
      return null;
    }
    return resp.data ?? null;
  }
}
