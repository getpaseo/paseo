import { describe, expect, it } from "vitest";

import { buildGitHubAttachmentFromSearchItem } from "./review-attachments";

describe("buildGitHubAttachmentFromSearchItem", () => {
  it("builds a github_pr attachment for pull requests", () => {
    const attachment = buildGitHubAttachmentFromSearchItem({
      kind: "pr",
      number: 123,
      title: "Fix race in worktree setup",
      url: "https://github.com/getpaseo/paseo/pull/123",
      state: "OPEN",
      body: "PR body",
      labels: ["bug"],
      baseRefName: "main",
      headRefName: "fix/worktree-race",
    });

    expect(attachment).toEqual({
      type: "github_pr",
      mimeType: "application/github-pr",
      number: 123,
      title: "Fix race in worktree setup",
      url: "https://github.com/getpaseo/paseo/pull/123",
      body: "PR body",
      baseRefName: "main",
      headRefName: "fix/worktree-race",
    });
  });

  it("builds a github_issue attachment for issues", () => {
    const attachment = buildGitHubAttachmentFromSearchItem({
      kind: "issue",
      number: 55,
      title: "Improve startup error details",
      url: "https://github.com/getpaseo/paseo/issues/55",
      state: "OPEN",
      body: "Issue body",
      labels: ["bug"],
    });

    expect(attachment).toEqual({
      type: "github_issue",
      mimeType: "application/github-issue",
      number: 55,
      title: "Improve startup error details",
      url: "https://github.com/getpaseo/paseo/issues/55",
      body: "Issue body",
    });
  });

  it("returns null when no item is selected", () => {
    expect(buildGitHubAttachmentFromSearchItem(null)).toBeNull();
  });
});
