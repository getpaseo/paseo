import { expect, test } from "vitest";
import { usageCopy } from "./copy";

test.each([
  [
    { kind: "expired", expiresAt: "2026-10-01T09:00:00Z", refreshedBy: "claude" },
    "Login expired 3h ago. Run claude to refresh it.",
  ],
  [{ kind: "expired", expiresAt: "2026-10-01T09:00:00Z" }, "Login expired 3h ago. Sign in again."],
  [
    { kind: "rejected", status: 403, refreshedBy: "codex" },
    "Login rejected (HTTP 403). Run codex to refresh it.",
  ],
  [{ kind: "rejected", status: 401 }, "Login rejected (HTTP 401). Sign in again."],
  [{ kind: "no_quota", detail: "No active coding plan" }, "No active coding plan"],
] as const)("problem %j", (problem, sentence) => {
  expect(usageCopy.problem(problem, new Date("2026-10-01T12:00:00Z"))).toBe(sentence);
});
