import { describe, expect, test } from "vitest";
import {
  relatedPullRequestsHealthCount,
  selectRelatedPullRequests,
  shouldPresentAsSet,
  summarizeRelatedPullRequests,
  type RelatedPullRequest,
} from "./related-pull-requests";

function pr(number: number, overrides: Partial<RelatedPullRequest> = {}): RelatedPullRequest {
  return {
    number,
    url: `https://github.com/acme/repo/pull/${number}`,
    state: "open",
    origin: "branch",
    ...overrides,
  };
}

describe("summarizeRelatedPullRequests", () => {
  test("one failing sibling decides the row, whatever the others say", () => {
    const summary = summarizeRelatedPullRequests([
      pr(1, { checksStatus: "success" }),
      pr(2, { checksStatus: "failure" }),
      pr(3, { checksStatus: "success" }),
    ]);

    expect(summary).toEqual({
      total: 3,
      openCount: 3,
      mergedCount: 0,
      health: "failing",
      checkCounts: { failing: 1, running: 0, passing: 2 },
    });
  });

  test("a merged layer's old failure stops holding the row back", () => {
    const summary = summarizeRelatedPullRequests([
      pr(1, { checksStatus: "failure", state: "merged" }),
      pr(2, { checksStatus: "success" }),
    ]);

    expect(summary.health).toBe("passing");
    expect(summary.openCount).toBe(1);
    expect(summary.total).toBe(2);
  });

  test("running outranks passing", () => {
    const summary = summarizeRelatedPullRequests([
      pr(1, { checksStatus: "success" }),
      pr(2, { checksStatus: "pending" }),
    ]);
    expect(summary.health).toBe("running");
  });

  test("failing outranks running", () => {
    const summary = summarizeRelatedPullRequests([
      pr(1, { checksStatus: "pending" }),
      pr(2, { checksStatus: "failure" }),
    ]);
    expect(summary.health).toBe("failing");
  });

  test("an empty set reports nothing rather than passing", () => {
    expect(summarizeRelatedPullRequests([])).toEqual({
      total: 0,
      openCount: 0,
      mergedCount: 0,
      health: "unknown",
      checkCounts: { failing: 0, running: 0, passing: 0 },
    });
  });

  test("change requests without checks do not read as green", () => {
    expect(summarizeRelatedPullRequests([pr(1, { checksStatus: "none" })]).health).toBe("unknown");
  });

  test("a merged failure is not counted as a red open change request", () => {
    const summary = summarizeRelatedPullRequests([
      pr(1, { checksStatus: "failure", state: "merged" }),
      pr(2, { checksStatus: "failure" }),
      pr(3, { checksStatus: "failure" }),
    ]);
    expect(summary.checkCounts).toEqual({ failing: 2, running: 0, passing: 0 });
  });
});

describe("relatedPullRequestsHealthCount", () => {
  test("the row's health word stands for that many change requests", () => {
    const summary = summarizeRelatedPullRequests([
      pr(1, { checksStatus: "failure" }),
      pr(2, { checksStatus: "failure" }),
      pr(3, { checksStatus: "success" }),
    ]);
    expect(relatedPullRequestsHealthCount(summary)).toBe(2);
  });

  test("a set with nothing to report counts nothing", () => {
    expect(relatedPullRequestsHealthCount(summarizeRelatedPullRequests([]))).toBe(0);
  });
});

describe("shouldPresentAsSet", () => {
  const onBranch = { onBranch: true, hasOwnChangeRequest: false };

  test("one change request is the row you expand to add the second", () => {
    expect(shouldPresentAsSet({ ...onBranch, pullRequests: [pr(1)] })).toBe(true);
    expect(shouldPresentAsSet({ ...onBranch, pullRequests: [pr(1), pr(2)] })).toBe(true);
  });

  test("a branch with none yet is where the first one gets attached", () => {
    expect(shouldPresentAsSet({ ...onBranch, pullRequests: [] })).toBe(true);
  });

  test("a workspace off any branch is not on a forge", () => {
    expect(
      shouldPresentAsSet({ pullRequests: [], onBranch: false, hasOwnChangeRequest: false }),
    ).toBe(false);
  });

  test("an unresolved set never replaces a change request the row already knows", () => {
    expect(
      shouldPresentAsSet({ pullRequests: [], onBranch: true, hasOwnChangeRequest: true }),
    ).toBe(false);
  });

  test("a resolved set outranks that fallback", () => {
    expect(
      shouldPresentAsSet({ pullRequests: [pr(1)], onBranch: true, hasOwnChangeRequest: true }),
    ).toBe(true);
  });
});

describe("selectRelatedPullRequests", () => {
  test("an older daemon that sends no set yields an empty list, not a crash", () => {
    expect(selectRelatedPullRequests(undefined)).toEqual([]);
    expect(selectRelatedPullRequests({ featuresEnabled: true })).toEqual([]);
  });

  test("returns the same empty reference so an unchanged row does not re-render", () => {
    expect(selectRelatedPullRequests(undefined)).toBe(selectRelatedPullRequests({}));
  });

  test("passes the set through", () => {
    const relatedPullRequests = [pr(1), pr(2)];
    expect(selectRelatedPullRequests({ relatedPullRequests })).toBe(relatedPullRequests);
  });
});
