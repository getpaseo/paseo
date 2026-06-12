import { describe, expect, it } from "vitest";
import type { PullRequestReviewThreadsError } from "@/git/use-pr-review-threads-query";
import { reviewThreadsErrorMessageKey } from "./pr-review-comment-error";

function err(kind: PullRequestReviewThreadsError["kind"]): PullRequestReviewThreadsError {
  return { kind, message: "boom" };
}

describe("reviewThreadsErrorMessageKey", () => {
  it("returns null when there is no error", () => {
    expect(reviewThreadsErrorMessageKey(null, null)).toBeNull();
  });

  it.each([
    ["missing_cli", "workspace.git.pr.reviewComments.errors.missingCli"],
    ["auth_required", "workspace.git.pr.reviewComments.errors.authRequired"],
    ["forbidden", "workspace.git.pr.reviewComments.errors.forbidden"],
    ["not_found", "workspace.git.pr.reviewComments.errors.notFound"],
    ["invalid_identity", "workspace.git.pr.reviewComments.errors.unknown"],
    ["unknown", "workspace.git.pr.reviewComments.errors.unknown"],
  ] as const)("maps the %s payload error kind to %s", (kind, key) => {
    expect(reviewThreadsErrorMessageKey(err(kind), null)).toBe(key);
  });

  it("maps a transport error to the unknown key when there is no payload error", () => {
    expect(reviewThreadsErrorMessageKey(null, new Error("network down"))).toBe(
      "workspace.git.pr.reviewComments.errors.unknown",
    );
  });

  it("prefers the payload error over a transport error", () => {
    expect(reviewThreadsErrorMessageKey(err("forbidden"), new Error("x"))).toBe(
      "workspace.git.pr.reviewComments.errors.forbidden",
    );
  });
});
