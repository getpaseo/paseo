import { describe, expect, it } from "vitest";
import type { PullRequestReviewThread } from "@getpaseo/protocol/messages";
import {
  buildReviewCommentBlock,
  buildReviewCommentsPrompt,
  formatReviewThreadLineRange,
  reviewCommentFenceLanguage,
} from "./pr-review-comment-prompt";

function thread(overrides: Partial<PullRequestReviewThread> = {}): PullRequestReviewThread {
  return {
    id: "PRT_1",
    path: "src/index.ts",
    line: 12,
    startLine: null,
    diffHunk: "@@ -8,4 +8,5 @@\n-const a = 1;\n+const a = 2;",
    isResolved: false,
    isOutdated: false,
    comments: [
      {
        id: "PRC_1",
        author: "octocat",
        body: "Please rename this variable.",
        url: "https://github.com/getpaseo/paseo/pull/42#discussion_r1",
        createdAt: 1710000000000,
      },
    ],
    ...overrides,
  };
}

describe("reviewCommentFenceLanguage", () => {
  it("derives the extension from the file path", () => {
    expect(reviewCommentFenceLanguage("src/index.ts")).toBe("ts");
    expect(reviewCommentFenceLanguage("a/b/c/Main.PY")).toBe("py");
  });

  it("returns an empty hint when there is no usable extension", () => {
    expect(reviewCommentFenceLanguage("Dockerfile")).toBe("");
    expect(reviewCommentFenceLanguage("src/trailing.")).toBe("");
    expect(reviewCommentFenceLanguage(".gitignore")).toBe("");
  });
});

describe("formatReviewThreadLineRange", () => {
  it("renders a single line when start and end match or start is absent", () => {
    expect(formatReviewThreadLineRange(thread({ line: 12, startLine: null }))).toBe("12");
    expect(formatReviewThreadLineRange(thread({ line: 12, startLine: 12 }))).toBe("12");
  });

  it("renders a range when start and end differ", () => {
    expect(formatReviewThreadLineRange(thread({ line: 15, startLine: 10 }))).toBe("10–15");
  });

  it("returns null when neither line is present", () => {
    expect(formatReviewThreadLineRange(thread({ line: null, startLine: null }))).toBeNull();
  });
});

describe("buildReviewCommentBlock", () => {
  it("formats a single-comment thread per the PRD layout", () => {
    expect(buildReviewCommentBlock(thread())).toBe(
      [
        "[PR review comment]",
        "File: src/index.ts",
        "Lines: 12",
        "Reviewer: octocat",
        "",
        "```ts",
        "@@ -8,4 +8,5 @@\n-const a = 1;\n+const a = 2;",
        "```",
        "",
        "Please rename this variable.",
      ].join("\n"),
    );
  });

  it("omits the Lines header when the thread has no line anchor", () => {
    const block = buildReviewCommentBlock(thread({ line: null, startLine: null }));
    expect(block).not.toContain("Lines:");
    expect(block).toContain("File: src/index.ts");
  });

  it("includes the whole discussion for multi-comment threads", () => {
    const block = buildReviewCommentBlock(
      thread({
        comments: [
          {
            id: "c1",
            author: "octocat",
            body: "Please rename this.",
            url: "u1",
            createdAt: 1,
          },
          {
            id: "c2",
            author: "contributor",
            body: "Done in the next commit.",
            url: "u2",
            createdAt: 2,
          },
        ],
      }),
    );
    expect(block).toContain("Reviewer: octocat");
    expect(block).toContain("octocat: Please rename this.");
    expect(block).toContain("contributor: Done in the next commit.");
  });
});

describe("buildReviewCommentsPrompt", () => {
  it("returns an empty string for no threads", () => {
    expect(buildReviewCommentsPrompt([])).toBe("");
  });

  it("returns a single block without a preamble for one thread", () => {
    const prompt = buildReviewCommentsPrompt([thread()]);
    expect(prompt.startsWith("[PR review comment]")).toBe(true);
    expect(prompt).not.toContain("Address the following");
  });

  it("prefixes a counted preamble and concatenates blocks for multiple threads", () => {
    const prompt = buildReviewCommentsPrompt([
      thread({ id: "a", path: "src/a.ts" }),
      thread({ id: "b", path: "src/b.ts" }),
    ]);
    expect(prompt.startsWith("Address the following 2 PR review comments:")).toBe(true);
    expect(prompt).toContain("File: src/a.ts");
    expect(prompt).toContain("File: src/b.ts");
  });
});
