import { describe, expect, it } from "vitest";

import { buildAgentBranchNameSeed, renderPromptAttachmentAsText } from "./prompt-attachments.js";

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

  it("renders github_issue attachments as readable text", () => {
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

  it("renders text attachments as their client-provided prompt text", () => {
    expect(
      renderPromptAttachmentAsText({
        type: "text",
        mimeType: "text/plain",
        title: "Browser element",
        text: "<browser-element>button.primary</browser-element>",
      }),
    ).toBe("<browser-element>button.primary</browser-element>");
  });

  it("returns undefined when firstAgentContext is empty", () => {
    expect(buildAgentBranchNameSeed(undefined)).toBeUndefined();
    expect(buildAgentBranchNameSeed({})).toBeUndefined();
    expect(buildAgentBranchNameSeed({ prompt: "   " })).toBeUndefined();
    expect(buildAgentBranchNameSeed({ attachments: [] })).toBeUndefined();
  });

  it("joins prompt and rendered attachments into a single seed", () => {
    expect(
      buildAgentBranchNameSeed({
        prompt: "Investigate flaky test",
        attachments: [
          {
            type: "github_pr",
            mimeType: "application/github-pr",
            number: 123,
            title: "Fix worktree naming",
            url: "https://github.com/getpaseo/paseo/pull/123",
            baseRefName: "main",
            headRefName: "fix/worktree-naming",
          },
        ],
      }),
    ).toBe(
      "Investigate flaky test\n\nGitHub PR #123: Fix worktree naming\nhttps://github.com/getpaseo/paseo/pull/123\nBase: main\nHead: fix/worktree-naming",
    );
  });
});
