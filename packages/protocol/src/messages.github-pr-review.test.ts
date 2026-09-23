import { CheckoutGithubReviewWriteRequestSchema } from "./messages.js";
import { describe, expect, it } from "vitest";

describe("github review write RPCs", () => {
  it("accepts a reply request", () => {
    const parsed = CheckoutGithubReviewWriteRequestSchema.parse({
      type: "checkout.github.review.write.request",
      action: "reply",
      cwd: "/repo",
      prNumber: 12,
      repoOwner: "acme",
      repoName: "app",
      threadId: "thread-1",
      body: "fixed",
      requestId: "req-1",
    });
    expect(parsed.threadId).toBe("thread-1");
  });

  it("accepts a comment request", () => {
    const parsed = CheckoutGithubReviewWriteRequestSchema.parse({
      type: "checkout.github.review.write.request",
      action: "comment",
      cwd: "/repo",
      prNumber: 12,
      repoOwner: "acme",
      repoName: "app",
      path: "src/a.ts",
      side: "new",
      line: 4,
      body: "nit",
      requestId: "req-2",
    });
    expect(parsed.side).toBe("new");
  });
});
