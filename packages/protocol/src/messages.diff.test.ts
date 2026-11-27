import { expect, test } from "vitest";
import { DiffSubscribeRequestSchema, DiffSubscribeResponseSchema } from "./messages.js";

test("accepts explicit endpoints without changing legacy schemas", () => {
  const request = {
    type: "diff.subscribe.request",
    requestId: "r",
    cwd: "/repo",
    base: { kind: "rev", rev: "v1" },
    head: { kind: "worktree" },
    mergeBase: true,
    highlight: false,
  };
  expect(DiffSubscribeRequestSchema.parse(request)).toEqual(request);
  expect(
    DiffSubscribeRequestSchema.safeParse({ ...request, base: { kind: "unknown" } }).success,
  ).toBe(false);
  expect(
    DiffSubscribeResponseSchema.safeParse({
      type: "diff.subscribe.response",
      payload: { requestId: "r", subscriptionId: "s", slot: 256, error: null },
    }).success,
  ).toBe(false);
});
