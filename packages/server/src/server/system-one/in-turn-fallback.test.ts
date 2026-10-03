import { expect, it } from "vitest";
import { isHardQuotaError, isQuotaOrRateLimitError } from "./in-turn-fallback.js";

it.each([
  "429",
  "quota exceeded",
  "rate_limit_exceeded",
  "Free usage exceeded, subscribe to Go",
  { code: "rate_limit_exceeded" },
  { diagnostic: "usage limit" },
])("recognizes quota evidence: %j", (error) => {
  expect(isQuotaOrRateLimitError(error)).toBe(true);
});
it.each(["Selected model is at capacity", "503 service unavailable", "timeout", null])(
  "does not invent account quota from capacity or transient failures: %j",
  (error) => {
    expect(isQuotaOrRateLimitError(error)).toBe(false);
  },
);

it.each([
  "Free usage exceeded, subscribe to Go",
  "insufficient_quota",
  "Quota exhausted",
  "Credits depleted",
])("recognizes terminal account exhaustion: %s", (message) => {
  expect(isHardQuotaError(message)).toBe(true);
  expect(isQuotaOrRateLimitError(message)).toBe(true);
});

it.each(["429 too many requests", "Internal server error", "Selected model is at capacity"])(
  "keeps retryable limits and transient failures separate: %s",
  (message) => expect(isHardQuotaError(message)).toBe(false),
);
