import { describe, expect, it } from "vitest";

import { shouldShowMergeFromBaseAction } from "./git-action-visibility";

describe("git-action-visibility", () => {
  describe("shouldShowMergeFromBaseAction", () => {
    it("shows on non-base branches", () => {
      expect(
        shouldShowMergeFromBaseAction({
          isOnBaseBranch: false,
          hasRemote: false,
          aheadOfOrigin: 0,
          behindOfOrigin: 0,
        })
      ).toBe(true);
    });

    it("hides on base branch when no remote exists", () => {
      expect(
        shouldShowMergeFromBaseAction({
          isOnBaseBranch: true,
          hasRemote: false,
          aheadOfOrigin: 0,
          behindOfOrigin: 0,
        })
      ).toBe(false);
    });

    it("hides on base branch when local is in sync with origin", () => {
      expect(
        shouldShowMergeFromBaseAction({
          isOnBaseBranch: true,
          hasRemote: true,
          aheadOfOrigin: 0,
          behindOfOrigin: 0,
        })
      ).toBe(false);
    });

    it("shows on base branch when ahead of origin", () => {
      expect(
        shouldShowMergeFromBaseAction({
          isOnBaseBranch: true,
          hasRemote: true,
          aheadOfOrigin: 1,
          behindOfOrigin: 0,
        })
      ).toBe(true);
    });

    it("shows on base branch when behind origin", () => {
      expect(
        shouldShowMergeFromBaseAction({
          isOnBaseBranch: true,
          hasRemote: true,
          aheadOfOrigin: 0,
          behindOfOrigin: 2,
        })
      ).toBe(true);
    });
  });
});
