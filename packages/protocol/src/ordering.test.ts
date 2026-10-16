import { expect, test } from "vitest";
import { applySharedOrder, OrderSetRequestSchema } from "./ordering.js";

test("shared order preserves local-only tabs and other hosts in their slots", () => {
  expect(
    applySharedOrder(["a", "local", "b", "other-host", "c"], ["c", "b", "a", "unopened"]),
  ).toEqual(["c", "local", "b", "other-host", "a"]);
});
test("missing and duplicate remote entries cannot erase local entries", () => {
  expect(applySharedOrder(["a", "b"], ["missing", "b", "b", "a"])).toEqual(["b", "a"]);
  expect(applySharedOrder(["a", "a", "b"], ["b", "a"])).toEqual(["b", "a", "a"]);
});
test("wire validation rejects invalid revisions and unbounded ordering payloads", () => {
  const request = {
    type: "ui.order.set.request",
    requestId: "r",
    scope: { kind: "tabs", workspaceId: "w" },
    expectedRevision: 0,
    order: ["a"],
  };
  expect(OrderSetRequestSchema.safeParse(request).success).toBe(true);
  expect(OrderSetRequestSchema.safeParse({ ...request, expectedRevision: -1 }).success).toBe(false);
  expect(
    OrderSetRequestSchema.safeParse({ ...request, order: Array(4097).fill("a") }).success,
  ).toBe(false);
});
