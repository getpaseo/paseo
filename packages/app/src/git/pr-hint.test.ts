import { describe, expect, it } from "vitest";

import { selectPrHintFromStatus } from "./pr-hint";

const githubStatus = {
  url: "https://github.com/acme/repo/pull/42",
  state: "open",
  isMerged: false,
};

const gitlabStatus = {
  url: "https://gitlab.com/group/proj/-/merge_requests/7",
  state: "open",
  isMerged: false,
};

describe("selectPrHintFromStatus", () => {
  it("defaults the forge to github when none is supplied (old daemon)", () => {
    const hint = selectPrHintFromStatus(githubStatus);
    expect(hint).toMatchObject({ number: 42, forge: "github" });
  });

  it("carries the resolved forge onto the hint", () => {
    const hint = selectPrHintFromStatus(githubStatus, "github");
    expect(hint?.forge).toBe("github");
  });

  it("parses a GitLab merge-request URL and carries the gitlab forge", () => {
    const hint = selectPrHintFromStatus(gitlabStatus, "gitlab");
    expect(hint).toMatchObject({ number: 7, forge: "gitlab" });
  });

  it("passes an unknown forge id through untouched", () => {
    const hint = selectPrHintFromStatus(githubStatus, "bitbucket");
    expect(hint?.forge).toBe("bitbucket");
  });

  it("returns null when the url has no parseable change-request number", () => {
    expect(
      selectPrHintFromStatus({ url: "https://example.com/x", state: "open", isMerged: false }),
    ).toBeNull();
  });
});
