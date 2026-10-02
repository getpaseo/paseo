import { expect, it } from "vitest";
import { isQuotaOrRateLimitError } from "./in-turn-fallback.js";

it.each([
  "429",
  "quota exceeded",
  "rate_limit_exceeded",
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
