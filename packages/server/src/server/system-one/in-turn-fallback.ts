import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";

const QUOTA_ERROR_PATTERN =
  /(?:rate\s*limit|rate_limit|too many requests|quota|usage limit|limit exceeded|resource exhausted|429)/i;

export function isQuotaOrRateLimitError(error: unknown): boolean {
  if (typeof error === "string") return QUOTA_ERROR_PATTERN.test(error);
  if (!error || typeof error !== "object") return false;
  const value = error as Record<string, unknown>;
  return [value.code, value.status, value.error, value.message, value.diagnostic].some(
    (part) => typeof part === "string" && QUOTA_ERROR_PATTERN.test(part),
  );
}

export function inTurnFallbackExhaustedVisibility(): AgentTimelineItem {
  return {
    type: "notification",
    level: "error",
    message:
      "Quota limit reached. No configured provider profile is available to continue this turn.",
  };
}
