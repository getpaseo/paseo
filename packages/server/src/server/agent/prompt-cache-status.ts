import type {
  AgentPromptCacheStatus,
  AgentPromptCacheTokens,
} from "@getpaseo/protocol/agent-types";
import type { PromptCacheSample } from "./agent-sdk-types.js";

function sampleTokens(sample: PromptCacheSample): AgentPromptCacheTokens {
  return {
    inputTokens: sample.inputTokens,
    cachedInputTokens: sample.cachedInputTokens,
    ...(sample.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: sample.cacheWriteTokens }),
  };
}

function isEmpty(tokens: AgentPromptCacheTokens): boolean {
  return (
    tokens.inputTokens === 0 && tokens.cachedInputTokens === 0 && !(tokens.cacheWriteTokens ?? 0)
  );
}

function addTokens(
  left: AgentPromptCacheTokens,
  right: AgentPromptCacheTokens,
): AgentPromptCacheTokens {
  const cacheWriteTokens =
    left.cacheWriteTokens === undefined && right.cacheWriteTokens === undefined
      ? undefined
      : (left.cacheWriteTokens ?? 0) + (right.cacheWriteTokens ?? 0);
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
}

function subtractTokens(
  current: AgentPromptCacheTokens,
  previous: AgentPromptCacheTokens,
): AgentPromptCacheTokens | null {
  const inputTokens = current.inputTokens - previous.inputTokens;
  const cachedInputTokens = current.cachedInputTokens - previous.cachedInputTokens;
  const cacheWriteTokens =
    current.cacheWriteTokens === undefined
      ? undefined
      : current.cacheWriteTokens - (previous.cacheWriteTokens ?? 0);
  if (inputTokens < 0 || cachedInputTokens < 0 || (cacheWriteTokens ?? 0) < 0) {
    return null;
  }
  return {
    inputTokens,
    cachedInputTokens,
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
}

/**
 * Folds a provider sample into the agent's prompt-cache status. Returns the
 * previous status untouched when the sample carries no new request: an empty
 * first sample, or cumulative totals that did not move.
 */
export function applyPromptCacheSample(
  previous: AgentPromptCacheStatus | undefined,
  sample: PromptCacheSample,
  observedAt: Date,
): AgentPromptCacheStatus | undefined {
  const tokens = sampleTokens(sample);
  let lastRequest: AgentPromptCacheTokens;
  let session: AgentPromptCacheTokens;
  let requestCount: number;

  if (sample.kind === "request") {
    if (isEmpty(tokens)) {
      return previous;
    }
    lastRequest = tokens;
    session = previous ? addTokens(previous.session, tokens) : tokens;
    requestCount = (previous?.session.requestCount ?? 0) + 1;
  } else {
    // Totals that went backwards mean the provider restarted its counters; the
    // new totals are then everything since the reset.
    const delta = previous ? subtractTokens(tokens, previous.session) : tokens;
    const resetSession = delta === null;
    const request = resetSession ? tokens : delta;
    if (isEmpty(request)) {
      return previous;
    }
    lastRequest = request;
    session = tokens;
    requestCount = resetSession || !previous ? 1 : previous.session.requestCount + 1;
  }

  return {
    observedAt: observedAt.toISOString(),
    ...(sample.ttlSeconds === undefined ? {} : { ttlSeconds: sample.ttlSeconds }),
    lastRequest,
    session: { ...session, requestCount },
  };
}
