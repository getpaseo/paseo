import { expect, it } from "vitest";
import { resolveChangesPresentation } from "./presentation";

it.each([
  [true, false, false, "combined"],
  [true, false, true, "combined"],
  [true, true, false, "combined"],
  [false, true, false, "combined"],
  [false, true, true, "combined"],
  [false, false, false, "tree"],
  [false, false, true, "combined"],
] as const)(
  "Changes compact=%s native=%s inline=%s renders %s",
  (isCompact, isNative, inlineDiff, expected) => {
    expect(resolveChangesPresentation({ isTree: true, isCompact, isNative, inlineDiff })).toBe(
      expected,
    );
    expect(resolveChangesPresentation({ isTree: false, isCompact, isNative, inlineDiff })).toBe(
      "diff",
    );
  },
);
