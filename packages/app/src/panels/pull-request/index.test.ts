import { describe, expect, it } from "vitest";
import { getPullRequestIdentity, resolvePullRequestContentState } from "./state";

describe("pull request panel", () => {
  it("resolves a manually opened panel without a pull request to the empty state", () => {
    expect(resolvePullRequestContentState({ data: null, error: null, isLoading: false })).toBe(
      "empty",
    );
  });

  it("uses the canonical URL as the stable detected pull request identity", () => {
    expect(
      getPullRequestIdentity({
        forge: "github",
        number: 42,
        url: "https://github.com/getpaseo/paseo/pull/42",
        title: "PR panel",
        state: "open",
        baseRefName: "main",
        headRefName: "feature",
        isMerged: false,
        isDraft: false,
        mergeable: "MERGEABLE",
        checks: [],
      }),
    ).toBe("url:https://github.com/getpaseo/paseo/pull/42");
  });

  it("does not manufacture an identity while detection has no result", () => {
    expect(getPullRequestIdentity(null)).toBeNull();
  });
});
