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

  it("marks an open GitHub pull request in the merge queue as queued", () => {
    const hint = selectPrHintFromStatus({
      ...githubStatus,
      forgeSpecific: { forge: "github", isInMergeQueue: true },
    });

    expect(hint?.state).toBe("queued");
  });

  it("does not call a pull request queued just because its repository uses a merge queue", () => {
    const hint = selectPrHintFromStatus({
      ...githubStatus,
      forgeSpecific: {
        forge: "github",
        isMergeQueueEnabled: true,
        isInMergeQueue: false,
      },
    });

    expect(hint?.state).toBe("open");
  });

  it("reads merge-queue facts from an older daemon's GitHub envelope", () => {
    const hint = selectPrHintFromStatus({
      ...githubStatus,
      github: { isInMergeQueue: true },
    });

    expect(hint?.state).toBe("queued");
  });

  it("keeps merged and closed states terminal even if queue facts are stale", () => {
    const forgeSpecific = { forge: "github", isInMergeQueue: true };

    expect(selectPrHintFromStatus({ ...githubStatus, isMerged: true, forgeSpecific })?.state).toBe(
      "merged",
    );
    expect(selectPrHintFromStatus({ ...githubStatus, state: "closed", forgeSpecific })?.state).toBe(
      "closed",
    );
  });

  it("returns null when the url has no parseable change-request number", () => {
    expect(
      selectPrHintFromStatus({ url: "https://example.com/x", state: "open", isMerged: false }),
    ).toBeNull();
  });
});
