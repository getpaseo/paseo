import { describe, expect, it } from "vitest";
import {
  buildCreateWorktreeInput,
  toDaemonCreateInput,
  type WorktreeCreateOptions,
} from "./create.js";

const REPO = "/tmp/repo";

function build(options: WorktreeCreateOptions): unknown {
  try {
    return buildCreateWorktreeInput(options, REPO);
  } catch (err) {
    return err;
  }
}

describe("buildCreateWorktreeInput", () => {
  it("requires --mode", () => {
    expect(build({})).toMatchObject({ code: "MISSING_MODE" });
  });

  it("rejects unknown modes", () => {
    expect(build({ mode: "fork" })).toMatchObject({ code: "INVALID_MODE" });
  });

  it("branch-off requires --new-branch", () => {
    expect(build({ mode: "branch-off" })).toMatchObject({ code: "MISSING_NEW_BRANCH" });
  });

  it("branch-off parses with new branch only", () => {
    expect(build({ mode: "branch-off", newBranch: "feature-x" })).toEqual({
      cwd: REPO,
      target: { mode: "branch-off", newBranch: "feature-x" },
    });
  });

  it("branch-off parses with base ref", () => {
    expect(build({ mode: "branch-off", newBranch: "feature-x", base: "main" })).toEqual({
      cwd: REPO,
      target: { mode: "branch-off", newBranch: "feature-x", base: "main" },
    });
  });

  it("checkout-branch requires --branch", () => {
    expect(build({ mode: "checkout-branch" })).toMatchObject({ code: "MISSING_BRANCH" });
  });

  it("checkout-branch parses with branch", () => {
    expect(build({ mode: "checkout-branch", branch: "feat/x" })).toEqual({
      cwd: REPO,
      target: { mode: "checkout-branch", branch: "feat/x" },
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

  it("checkout-pr parses positive integers", () => {
    expect(build({ mode: "checkout-pr", prNumber: "42" })).toEqual({
      cwd: REPO,
      target: { mode: "checkout-pr", prNumber: 42 },
    });
  });
});

describe("toDaemonCreateInput", () => {
  it("maps branch-off without base", () => {
    expect(
      toDaemonCreateInput({
        cwd: REPO,
        target: { mode: "branch-off", newBranch: "feature-x" },
      }),
    ).toEqual({
      cwd: REPO,
      worktreeSlug: "feature-x",
      action: "branch-off",
    });
  });

  it("maps branch-off with base ref", () => {
    expect(
      toDaemonCreateInput({
        cwd: REPO,
        target: { mode: "branch-off", newBranch: "feature-x", base: "main" },
      }),
    ).toEqual({
      cwd: REPO,
      worktreeSlug: "feature-x",
      action: "branch-off",
      refName: "main",
    });
  });

  it("maps checkout-branch to action=checkout + refName", () => {
    expect(
      toDaemonCreateInput({
        cwd: REPO,
        target: { mode: "checkout-branch", branch: "feat/x" },
      }),
    ).toEqual({
      cwd: REPO,
      action: "checkout",
      refName: "feat/x",
    });
  });

  it("maps checkout-pr to action=checkout + githubPrNumber", () => {
    expect(
      toDaemonCreateInput({
        cwd: REPO,
        target: { mode: "checkout-pr", prNumber: 42 },
      }),
    ).toEqual({
      cwd: REPO,
      action: "checkout",
      githubPrNumber: 42,
    });
  });
});
