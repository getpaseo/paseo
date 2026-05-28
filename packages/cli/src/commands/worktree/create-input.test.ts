import { describe, expect, it } from "vitest";
import { buildCreateWorktreeRequest, type WorktreeCreateOptions } from "./create-input.js";

const REPO = "/tmp/repo";

function build(options: WorktreeCreateOptions): unknown {
  try {
    return buildCreateWorktreeRequest(options, REPO);
  } catch (err) {
    return err;
  }
}

describe("buildCreateWorktreeRequest", () => {
  it("requires --mode", () => {
    expect(build({})).toMatchObject({ code: "MISSING_MODE" });
  });

  it("rejects unknown modes", () => {
    expect(build({ mode: "fork" })).toMatchObject({ code: "INVALID_MODE" });
  });

  it("branch-off requires --new-branch", () => {
    expect(build({ mode: "branch-off" })).toMatchObject({ code: "MISSING_NEW_BRANCH" });
  });

  it("branch-off builds a daemon request with a new branch", () => {
    expect(build({ mode: "branch-off", newBranch: "feature-x" })).toEqual({
      cwd: REPO,
      worktreeSlug: "feature-x",
      action: "branch-off",
    });
  });

  it("branch-off includes the base ref when provided", () => {
    expect(build({ mode: "branch-off", newBranch: "feature-x", base: "main" })).toEqual({
      cwd: REPO,
      worktreeSlug: "feature-x",
      action: "branch-off",
      refName: "main",
    });
  });

  it("checkout-branch requires --branch", () => {
    expect(build({ mode: "checkout-branch" })).toMatchObject({ code: "MISSING_BRANCH" });
  });

  it("checkout-branch builds a checkout request for the branch", () => {
    expect(build({ mode: "checkout-branch", branch: "feat/x" })).toEqual({
      cwd: REPO,
      action: "checkout",
      refName: "feat/x",
    });
  });

  it("checkout-pr requires --pr-number", () => {
    expect(build({ mode: "checkout-pr" })).toMatchObject({ code: "MISSING_PR_NUMBER" });
  });

  it("checkout-pr rejects non-positive integers", () => {
    expect(build({ mode: "checkout-pr", prNumber: "0" })).toMatchObject({
      code: "INVALID_PR_NUMBER",
    });
  });

  it("checkout-pr rejects non-integer values", () => {
    expect(build({ mode: "checkout-pr", prNumber: "abc" })).toMatchObject({
      code: "INVALID_PR_NUMBER",
    });
  });

  it("checkout-pr builds a checkout request for the pull request", () => {
    expect(build({ mode: "checkout-pr", prNumber: "42" })).toEqual({
      cwd: REPO,
      action: "checkout",
      githubPrNumber: 42,
    });
  });
});
