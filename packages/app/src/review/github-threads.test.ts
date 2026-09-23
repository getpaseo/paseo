import { describe, expect, it } from "vitest";
import type { PullRequestTimelineItem } from "@getpaseo/protocol/messages";
import { collectVisibleReviewTargetKeys, mapGithubReviewOverlay } from "./github-threads";
import type { ParsedDiffFile } from "@/git/use-diff-query";

function file(path: string): ParsedDiffFile {
  return {
    path,
    isNew: false,
    isDeleted: false,
    additions: 1,
    deletions: 0,
    hunks: [
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 2,
        lines: [
          { type: "header", content: "@@ -1,1 +1,2 @@" },
          { type: "context", content: "keep" },
          { type: "add", content: "added" },
        ],
      },
    ],
  };
}

function comment(
  overrides: Partial<Extract<PullRequestTimelineItem, { kind: "comment" }>> & {
    location: NonNullable<Extract<PullRequestTimelineItem, { kind: "comment" }>["location"]>;
  },
): PullRequestTimelineItem {
  return {
    kind: "comment",
    id: "c1",
    author: "ada",
    body: "nit",
    createdAt: 1,
    url: "https://example.test",
    ...overrides,
  };
}

describe("mapGithubReviewOverlay", () => {
  it("places a matching thread on the new-side target", () => {
    const files = [file("src/a.ts")];
    const overlay = mapGithubReviewOverlay({
      items: [
        comment({
          location: { path: "src/a.ts", line: 2, threadId: "t1", side: "new", isOutdated: false },
        }),
      ],
      visibleTargetKeys: collectVisibleReviewTargetKeys(files),
    });
    expect(overlay.threadsByTarget.get("src/a.ts:new:2")?.[0]?.comments[0]?.author).toBe("ada");
    expect(overlay.unmatchedOutdatedByPath.size).toBe(0);
  });

  it("counts unmatched outdated threads on the file header", () => {
    const overlay = mapGithubReviewOverlay({
      items: [
        comment({
          location: {
            path: "src/a.ts",
            line: 99,
            threadId: "t-old",
            side: "new",
            isOutdated: true,
          },
        }),
      ],
      visibleTargetKeys: collectVisibleReviewTargetKeys([file("src/a.ts")]),
    });
    expect(overlay.threadsByTarget.size).toBe(0);
    expect(overlay.unmatchedOutdatedByPath.get("src/a.ts")).toBe(1);
  });
});
