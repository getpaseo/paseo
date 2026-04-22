import { describe, expect, it } from "vitest";

import { findGitHubPrAttachment, renderPromptAttachmentAsText } from "./prompt-attachments.js";

describe("prompt attachments", () => {
  it("renders github_pr attachments as readable text", () => {
    expect(
      renderPromptAttachmentAsText({
        type: "github_pr",
        mimeType: "application/github-pr",
        number: 123,
        title: "Fix race in worktree setup",
        url: "https://github.com/getpaseo/paseo/pull/123",
        body: "PR body",
        baseRefName: "main",
        headRefName: "fix/worktree-race",
      }),
    ).toContain("GitHub PR #123: Fix race in worktree setup");
  });

  it("finds the first github_pr attachment", () => {
    expect(
      findGitHubPrAttachment([
        {
          type: "github_issue",
          mimeType: "application/github-issue",
          number: 55,
          title: "Issue",
          url: "https://github.com/getpaseo/paseo/issues/55",
        },
        {
          type: "github_pr",
          mimeType: "application/github-pr",
          number: 123,
          title: "PR",
          url: "https://github.com/getpaseo/paseo/pull/123",
        },
      ]),
    ).toEqual({
      type: "github_pr",
      mimeType: "application/github-pr",
      number: 123,
      title: "PR",
      url: "https://github.com/getpaseo/paseo/pull/123",
    });
  });
});
