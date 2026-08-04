import type { Logger } from "pino";
import { z } from "zod";
import type {
  ProviderUsage,
  ProviderUsageDetail,
  ProviderUsageWindow,
} from "../../../server/messages.js";
import type {
  ProviderApiFetch,
  ProviderUsageAgentProviderConfigs,
  ProviderUsageFetcher,
} from "../provider.js";
import {
  ApiNullableNumberSchema,
  ApiNumberSchema,
  ApiOptionalStringSchema,
  fetchProviderApi,
  toneFromUsedPct,
  toIsoStringOrNull,
  unavailableUsage,
  windowFromUsedPct,
} from "../usage.js";

const ZAI_ORIGIN = "https://api.z.ai";
const GLM_CN_ORIGIN = "https://open.bigmodel.cn";
const MONITOR_PATH = "/api/monitor/usage/quota/limit";
const SUBSCRIPTION_PATH = "/api/biz/subscription/list";
/**
 * Optional subscription metadata (plan name / validity) is fetched in parallel with the
 * authoritative monitor call and is given a tighter timeout than the monitor request so
 * a slow or failing metadata endpoint can never delay the otherwise-complete quota
 * result. When it times out or fails we degrade to monitor-only data.
 */
const ZAI_SUBSCRIPTION_TIMEOUT_MS = 4_000;

const ZaiMonitorResponseSchema = z.object({
  code: ApiNullableNumberSchema.optional(),
  success: z.boolean().optional(),
  data: z
    .object({
      level: ApiOptionalStringSchema,
      limits: z
        .array(
          z.object({
            type: z.string(),
            unit: ApiNumberSchema.optional(),
            number: ApiNumberSchema.optional(),
            percentage: ApiNullableNumberSchema.optional(),
            nextResetTime: ApiNullableNumberSchema.optional(),
          }),
        )
        .default([]),
    })
    .optional(),
});

const ZaiUsageResponseSchema = z.object({
  data: z
    .array(
      z.object({
        productName: ApiOptionalStringSchema,
        status: ApiOptionalStringSchema,
        purchaseTime: ApiOptionalStringSchema,
        valid: ApiOptionalStringSchema,
      }),
    )
    .optional(),
});

type ZaiSubscription = NonNullable<z.infer<typeof ZaiUsageResponseSchema>["data"]>[number];
type ZaiQuotaLimit = NonNullable<
  z.infer<typeof ZaiMonitorResponseSchema>["data"]
>["limits"][number];

interface ZaiQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
  env?: NodeJS.ProcessEnv;
  getAgentProviderConfigs?: () => ProviderUsageAgentProviderConfigs;
}

interface ZaiCredential {
  token: string;
  origin: string;
}

function resolveZaiOrigin(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    if (url.hostname === "api.z.ai") return ZAI_ORIGIN;
    if (url.hostname === "open.bigmodel.cn") return GLM_CN_ORIGIN;
  } catch {
    return null;
  }
  return null;
}

function resolveZaiCredential(
  env: NodeJS.ProcessEnv,
  providerConfigs: ProviderUsageAgentProviderConfigs,
): ZaiCredential | null {
  const zaiToken = env["ZAI_API_KEY"]?.trim();
  if (zaiToken) return { token: zaiToken, origin: ZAI_ORIGIN };

  const glmToken = env["GLM_API_KEY"]?.trim();
  if (glmToken) return { token: glmToken, origin: GLM_CN_ORIGIN };

  // Persisted agent-provider profiles are only consulted after env vars. Selection is
  // bound to provider identity (a Z.ai / GLM China base URL) and the profile's enabled
  // state: a disabled profile (enabled === false) is skipped, and when several enabled
  // profiles target Z.ai the lowest configured `order` wins so we surface the user's
  // primary account rather than whichever entry happens to iterate first.
  const ranked = Object.entries(providerConfigs)
    .filter(([, provider]) => provider?.enabled !== false)
    .flatMap(([id, provider]) => {
      const providerEnv = provider?.env;
      const origin = resolveZaiOrigin(providerEnv?.["ANTHROPIC_BASE_URL"]);
      const token =
        providerEnv?.["ANTHROPIC_AUTH_TOKEN"]?.trim() ||
        providerEnv?.["ANTHROPIC_API_KEY"]?.trim();
      // Only profiles that resolve to a Z.ai/GLM identity and carry a token are candidates.
      if (!origin || !token) return [];
      return [{ id, origin, token, order: provider?.order }];
    })
    .sort((a, b) => compareByOrderThenId(a.order, b.order, a.id, b.id));

  const selected = ranked[0];
  return selected ? { token: selected.token, origin: selected.origin } : null;
}

/** Lowest order wins (undefined sorts last), then profile id for a stable tiebreak. */
function compareByOrderThenId(
  orderA: number | undefined,
  orderB: number | undefined,
  idA: string,
  idB: string,
): number {
  const left = orderA ?? Number.POSITIVE_INFINITY;
  const right = orderB ?? Number.POSITIVE_INFINITY;
  if (left !== right) return left < right ? -1 : 1;
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}

function toUsageWindows(limits: ZaiQuotaLimit[]): ProviderUsageWindow[] {
  const windowDefinitions = [
    {
      id: "session",
      label: "Session (5h)",
      find: (limit: ZaiQuotaLimit) =>
        limit.type === "TOKENS_LIMIT" && limit.unit === 3 && limit.number === 5,
    },
    {
      id: "weekly",
      label: "Weekly (7d)",
      find: (limit: ZaiQuotaLimit) =>
        limit.type === "TOKENS_LIMIT" && limit.unit === 6 && limit.number === 1,
    },
    {
      id: "monthly-tools",
      label: "MCP tools (monthly)",
      find: (limit: ZaiQuotaLimit) =>
        limit.type === "TIME_LIMIT" && limit.unit === 5 && limit.number === 1,
    },
  ] as const;

  return windowDefinitions.flatMap((definition) => {
    const limit = limits.find(definition.find);
    if (!limit) return [];

    const usedPct = limit.percentage;
    return [
      windowFromUsedPct({
        id: definition.id,
        label: definition.label,
        utilizationPct: usedPct,
        resetsAt: limit.nextResetTime == null ? null : toIsoStringOrNull(limit.nextResetTime),
        tone: toneFromUsedPct(usedPct),
      }),
    ];
  });
}

export class ZaiQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "zai";
  readonly displayName = "Z.ai";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;
  private readonly env: NodeJS.ProcessEnv;
  private readonly getAgentProviderConfigs: () => ProviderUsageAgentProviderConfigs;

  constructor(options: ZaiQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
    this.env = options.env ?? process.env;
    this.getAgentProviderConfigs = options.getAgentProviderConfigs ?? (() => ({}));
  }

  private async fetchSubscription(credential: ZaiCredential): Promise<ZaiSubscription | undefined> {
    if (credential.origin !== ZAI_ORIGIN) return undefined;

    try {
      const response = await fetchProviderApi(
        this.fetchApi,
        `${credential.origin}${SUBSCRIPTION_PATH}`,
        {
          // Tighter than the monitor timeout: this is optional metadata, and a slow/hung
          // endpoint must not hold back the quota result that the monitor already gave us.
          signal: AbortSignal.timeout(ZAI_SUBSCRIPTION_TIMEOUT_MS),
          headers: {
            Authorization: `Bearer ${credential.token}`,
            Accept: "application/json",
          },
        },
      );
      if (response.ok) {
        return ZaiUsageResponseSchema.parse(await response.json()).data?.[0];
      }
      this.logger.debug({ status: response.status }, "Z.ai subscription metadata fetch failed");
    } catch (error) {
      this.logger.debug({ err: error }, "Z.ai subscription metadata fetch failed");
    }
    return undefined;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const credential = resolveZaiCredential(this.env, this.getAgentProviderConfigs());
    if (!credential) return unavailableUsage(this);

    // The monitor call is authoritative for availability; the subscription call only adds
    // optional metadata. Run them concurrently so the optional metadata cannot delay the
    // monitor-derived quota. fetchSubscription never rejects and is timeout-bounded, so a
    // metadata failure or hang degrades to monitor-only data instead of blocking the result.
    const subscriptionPromise = this.fetchSubscription(credential);

    const monitorRes = await fetchProviderApi(
      this.fetchApi,
      `${credential.origin}${MONITOR_PATH}`,
      {
        headers: {
          Authorization: credential.token,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      },
    );

    if (!monitorRes.ok) {
      this.logger.debug({ status: monitorRes.status }, "Z.ai quota fetch failed");
      // The monitor already failed; the optional metadata is useless, so do not wait on it.
      void subscriptionPromise;
      return unavailableUsage(this);
    }

    const monitor = ZaiMonitorResponseSchema.parse(await monitorRes.json());
    if (
      monitor.success === false ||
      (monitor.code != null && monitor.code !== 200) ||
      !monitor.data
    ) {
      this.logger.debug({ code: monitor.code }, "Z.ai quota API rejected request");
      void subscriptionPromise;
      return unavailableUsage(this);
    }
    const windows = toUsageWindows(monitor.data?.limits ?? []);

    const sub = await subscriptionPromise;

    const details: ProviderUsageDetail[] = [];
    if (sub?.status) details.push({ id: "status", label: "Status", value: sub.status });
    if (sub?.valid) details.push({ id: "valid", label: "Valid", value: sub.valid });
    if (sub?.purchaseTime) {
      details.push({ id: "purchase_time", label: "Purchased", value: sub.purchaseTime });
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: sub?.productName || monitor.data?.level || "Coding Plan",
      windows,
      balances: [],
      details,
      error: null,
    };
  }
}
