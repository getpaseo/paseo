import { expect, test } from "vitest";
import {
  balanceToneFromRemaining,
  toneFromUsedPct,
  usedPctOf,
  windowFromUsedPct,
} from "./usage.js";

test("shared usage tones preserve the app threshold contract", () => {
  expect([null, 69.9, 70, 90, 90.1].map(toneFromUsedPct)).toEqual([
    "default",
    "ok",
    "warning",
    "warning",
    "danger",
  ]);
  expect([null, 0, 0.01].map(balanceToneFromRemaining)).toEqual(["default", "danger", "ok"]);
});

test("shared windows retain percentage, reset time, and optional headline", () => {
  expect(windowFromUsedPct({ id: "a", label: "A", utilizationPct: 30, headline: true })).toEqual({
    id: "a",
    label: "A",
    usedPct: 30,
    remainingPct: 70,
    resetsAt: null,
    headline: true,
  });
  expect(windowFromUsedPct({ id: "b", label: "B", utilizationPct: null })).toEqual({
    id: "b",
    label: "B",
    usedPct: null,
    remainingPct: null,
    resetsAt: null,
  });
  expect(usedPctOf(25, 100)).toBe(25);
  expect(usedPctOf(25, 0)).toBeNull();
});
