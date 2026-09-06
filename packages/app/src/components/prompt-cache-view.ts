import type {
  AgentPromptCacheStatus,
  AgentPromptCacheTokens,
} from "@getpaseo/protocol/agent-types";

/**
 * "unknown" means the provider documents no cache lifetime, so the age of the last
 * request is all we can report.
 */
export type PromptCacheLifetime = "warm" | "expiring" | "expired" | "unknown";

export interface PromptCacheTokenSplit {
  /** cached / (uncached + cached + written), as a whole percentage. */
  hitPercent: number;
  cachedTokens: number;
  freshTokens: number;
  /** Null when the provider does not report cache writes. */
  writtenTokens: number | null;
}

export interface PromptCacheView {
  lifetime: PromptCacheLifetime;
  /** Seconds left before the cache lapses. Null when the lifetime is unknown. */
  remainingSeconds: number | null;
  /** Seconds since the cache lapsed. Null unless the lifetime is "expired". */
  expiredForSeconds: number | null;
  /** Seconds since the last model request that reported cache figures. */
  elapsedSeconds: number;
  lastRequest: PromptCacheTokenSplit;
  session: PromptCacheTokenSplit & { requestCount: number };
}

const EXPIRING_SOON_SECONDS = 60;

function finite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function toSplit(tokens: AgentPromptCacheTokens): PromptCacheTokenSplit {
  const cachedTokens = finite(tokens.cachedInputTokens);
  const freshTokens = finite(tokens.inputTokens);
  const writtenTokens =
    tokens.cacheWriteTokens === undefined ? null : finite(tokens.cacheWriteTokens);
  const total = cachedTokens + freshTokens + (writtenTokens ?? 0);
  return {
    hitPercent: total > 0 ? Math.round((cachedTokens / total) * 100) : 0,
    cachedTokens,
    freshTokens,
    writtenTokens,
  };
}

function elapsedSecondsSince(observedAt: string, nowMs: number): number {
  const observedMs = Date.parse(observedAt);
  if (Number.isNaN(observedMs)) return 0;
  return Math.max(0, Math.floor((nowMs - observedMs) / 1000));
}

export function derivePromptCacheView(
  status: AgentPromptCacheStatus,
  nowMs: number,
): PromptCacheView {
  const elapsedSeconds = elapsedSecondsSince(status.observedAt, nowMs);
  const ttlSeconds = finite(status.ttlSeconds) || null;
  const lastRequest = toSplit(status.lastRequest);
  const session = { ...toSplit(status.session), requestCount: finite(status.session.requestCount) };

  if (ttlSeconds === null) {
    return {
      lifetime: "unknown",
      remainingSeconds: null,
      expiredForSeconds: null,
      elapsedSeconds,
      lastRequest,
      session,
    };
  }

  const remaining = ttlSeconds - elapsedSeconds;
  if (remaining <= 0) {
    return {
      lifetime: "expired",
      remainingSeconds: 0,
      expiredForSeconds: elapsedSeconds - ttlSeconds,
      elapsedSeconds,
      lastRequest,
      session,
    };
  }

  return {
    lifetime: remaining > EXPIRING_SOON_SECONDS ? "warm" : "expiring",
    remainingSeconds: remaining,
    expiredForSeconds: null,
    elapsedSeconds,
    lastRequest,
    session,
  };
}
