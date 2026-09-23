import { describe, expect, it } from "vitest";
import { createGithubPrReviewApi } from "./github-pr-review.js";

function argsInclude(args: string[], fragment: string): boolean {
  return args.some((arg) => arg.includes(fragment));
}

describe("createGithubPrReviewApi", () => {
  it("replies on a review thread", async () => {
    const calls: string[][] = [];
    const api = createGithubPrReviewApi(async (args) => {
      calls.push(args);
      return {
        data: { addPullRequestReviewThreadReply: { comment: { id: "comment-1" } } },
      };
    });
    const result = await api.reply({
      cwd: "/repo",
      repoOwner: "acme",
      repoName: "app",
      prNumber: 12,
      threadId: "thread-1",
      body: "fixed",
    });
    expect(result.commentId).toBe("comment-1");
    expect(result.threadId).toBe("thread-1");
    expect(calls[0]?.join(" ")).toContain("addPullRequestReviewThreadReply");
    expect(calls[0]).toContain("threadId=thread-1");
  });

  it("starts a pending review then adds a thread", async () => {
    const calls: string[][] = [];
    const api = createGithubPrReviewApi(async (args) => {
      calls.push(args);
      if (argsInclude(args, "pullRequest(number")) {
        return { data: { repository: { pullRequest: { id: "pr-id" } } } };
      }
      if (argsInclude(args, "addPullRequestReviewThread(")) {
        return { data: { addPullRequestReviewThread: { thread: { id: "thread-2" } } } };
      }
      return { data: { addPullRequestReview: { pullRequestReview: { id: "review-1" } } } };
    });
    const started = await api.draft({
      cwd: "/repo",
      repoOwner: "acme",
      repoName: "app",
      prNumber: 12,
      path: "src/a.ts",
      side: "new",
      line: 10,
      body: "nits",
    });
    expect(started.reviewId).toBe("review-1");
    const added = await api.draft({
      cwd: "/repo",
      repoOwner: "acme",
      repoName: "app",
      prNumber: 12,
      path: "src/a.ts",
      side: "old",
      line: 4,
      body: "more",
      reviewId: "review-1",
    });
    expect(added.threadId).toBe("thread-2");
    expect(calls.some((call) => call.includes("side=RIGHT"))).toBe(true);
    expect(calls.some((call) => call.includes("side=LEFT"))).toBe(true);
  });

  it("submits a pending review", async () => {
    const api = createGithubPrReviewApi(async () => ({
      data: { submitPullRequestReview: { pullRequestReview: { id: "review-1" } } },
    }));
    const result = await api.submit({
      cwd: "/repo",
      repoOwner: "acme",
      repoName: "app",
      prNumber: 12,
      reviewId: "review-1",
      event: "request_changes",
      body: "please fix",
    });
    expect(result.reviewId).toBe("review-1");
  });
});
