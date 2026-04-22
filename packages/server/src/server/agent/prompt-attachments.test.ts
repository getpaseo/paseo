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

  it("renders review attachments with compact file, line, comment, and context details", () => {
    expect(
      renderPromptAttachmentAsText({
        type: "review",
        mimeType: "application/paseo-review",
        cwd: "/tmp/repo",
        mode: "base",
        baseRef: "main",
        comments: [
          {
            filePath: "src/index.ts",
            side: "new",
            lineNumber: 42,
            body: "Please guard this nullable value.",
            context: {
              hunkHeader: "@@ -40,3 +40,4 @@",
              targetLine: {
                oldLineNumber: null,
                newLineNumber: 42,
                type: "add",
                content: "const value = maybeNull.name;",
              },
              lines: [
                {
                  oldLineNumber: 41,
                  newLineNumber: 41,
                  type: "context",
                  content: "const before = true;",
                },
                {
                  oldLineNumber: null,
                  newLineNumber: 42,
                  type: "add",
                  content: "const value = maybeNull.name;",
                },
              ],
            },
          },
        ],
      }),
    ).toBe(
      [
        "Paseo review attachment (base)",
        "CWD: /tmp/repo",
        "Base: main",
        "",
        "Comment 1: src/index.ts:new:42",
        "Please guard this nullable value.",
        "@@ -40,3 +40,4 @@",
        "  41 41  const before = true;",
        ">  - 42 +const value = maybeNull.name;",
      ].join("\n"),
    );
  });

  it("renders prompt attachments centrally and returns null for unsupported blocks", () => {
    expect(renderPromptAttachmentAsText(null)).toBeNull();
    expect(renderPromptAttachmentAsText(undefined)).toBeNull();
    expect(renderPromptAttachmentAsText({ type: "text", text: "hello" })).toBeNull();
    expect(
      renderPromptAttachmentAsText({
        type: "image",
        mimeType: "image/png",
        data: "base64",
      }),
    ).toBeNull();
    expect(
      renderPromptAttachmentAsText({
        type: "github_issue",
        mimeType: "application/github-issue",
        number: 55,
        title: "Issue",
        url: "https://github.com/getpaseo/paseo/issues/55",
      }),
    ).toContain("GitHub Issue #55: Issue");
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
