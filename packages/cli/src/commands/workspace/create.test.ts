import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspaceSource } from "./create.js";

describe("workspace create source", () => {
  it("maps local isolation to a directory workspace", () => {
    expect(
      buildWorkspaceSource({ isolation: "local", path: "/tmp/project", project: "project-1" }),
    ).toEqual({ kind: "directory", path: "/tmp/project", projectId: "project-1" });
  });

  it("resolves a relative path against the directory the command runs in", () => {
    const daemonTarget = { kind: "instance" as const, home: "/tmp/paseo-home" };
    expect(buildWorkspaceSource({ daemonTarget, isolation: "local", path: "." })).toEqual({
      kind: "directory",
      path: process.cwd(),
    });
    expect(
      buildWorkspaceSource({ daemonTarget, isolation: "worktree", path: "../sibling" }),
    ).toEqual({
      kind: "worktree",
      cwd: path.resolve(process.cwd(), "../sibling"),
      action: "branch-off",
    });
  });

  it("sends a relative path to an explicit daemon endpoint as written", () => {
    const daemonTarget = { kind: "endpoint" as const, host: "other-box:6767" };
    expect(buildWorkspaceSource({ daemonTarget, isolation: "local", path: "repo" })).toEqual({
      kind: "directory",
      path: "repo",
    });
  });

  it("passes an absolute path from another operating system through unchanged", () => {
    expect(buildWorkspaceSource({ isolation: "local", path: "C:\\repos\\project" })).toEqual({
      kind: "directory",
      path: "C:\\repos\\project",
    });
  });

  it("leaves a home-relative path for the daemon to expand", () => {
    const daemonTarget = { kind: "instance" as const, home: "/tmp/paseo-home" };
    expect(buildWorkspaceSource({ daemonTarget, isolation: "local", path: "~/repo" })).toEqual({
      kind: "directory",
      path: "~/repo",
    });
    expect(buildWorkspaceSource({ daemonTarget, isolation: "worktree", path: "~" })).toEqual({
      kind: "worktree",
      cwd: "~",
      action: "branch-off",
    });
  });

  it("keeps branch names separate from managed worktree slugs", () => {
    expect(
      buildWorkspaceSource({
        isolation: "worktree",
        path: "/tmp/project",
        mode: "branch-off",
        newBranch: "feature/auth",
        worktreeSlug: "feature-auth",
        base: "main",
      }),
    ).toEqual({
      kind: "worktree",
      cwd: "/tmp/project",
      action: "branch-off",
      branchName: "feature/auth",
      worktreeSlug: "feature-auth",
      baseBranch: "main",
    });
  });

  it("uses a project as the worktree source without capturing the ambient directory", () => {
    expect(
      buildWorkspaceSource({
        isolation: "worktree",
        project: "project-1",
        mode: "branch-off",
        newBranch: "fix-x",
      }),
    ).toEqual({
      kind: "worktree",
      projectId: "project-1",
      action: "branch-off",
      branchName: "fix-x",
    });
  });

  it("checks out an existing branch into a worktree workspace", () => {
    expect(
      buildWorkspaceSource({
        isolation: "worktree",
        path: "/tmp/project",
        mode: "checkout-branch",
        branch: "existing-work",
        worktreeSlug: "existing-work-copy",
      }),
    ).toEqual({
      kind: "worktree",
      cwd: "/tmp/project",
      action: "checkout",
      refName: "existing-work",
      worktreeSlug: "existing-work-copy",
    });
  });

  it("checks out a pull request into a worktree workspace", () => {
    expect(
      buildWorkspaceSource({
        isolation: "worktree",
        path: "/tmp/project",
        mode: "checkout-pr",
        prNumber: "42",
        forge: "gitlab",
      }),
    ).toEqual({
      kind: "worktree",
      cwd: "/tmp/project",
      action: "checkout",
      checkoutSource: {
        kind: "change_request",
        forge: "gitlab",
        number: 42,
      },
    });
  });

  it("lets the source checkout select the forge when it is omitted", () => {
    expect(
      buildWorkspaceSource({
        isolation: "worktree",
        path: "/tmp/project",
        mode: "checkout-pr",
        prNumber: "42",
      }),
    ).toEqual({
      kind: "worktree",
      cwd: "/tmp/project",
      action: "checkout",
      checkoutSource: {
        kind: "change_request",
        number: 42,
      },
    });
  });

  it("requires the mode-specific checkout target", () => {
    expect(() => buildWorkspaceSource({ isolation: "worktree", mode: "checkout-branch" })).toThrow(
      "--branch is required",
    );
    expect(() => buildWorkspaceSource({ isolation: "worktree", mode: "checkout-pr" })).toThrow(
      "--pr-number is required",
    );
  });

  it("rejects worktree options for local isolation", () => {
    expect(() => buildWorkspaceSource({ isolation: "local", mode: "branch-off" })).toThrow(
      "Worktree options require --isolation worktree",
    );
  });

  it("rejects unknown isolation", () => {
    expect(() => buildWorkspaceSource({ isolation: "container" })).toThrow(
      "Unsupported workspace isolation",
    );
  });
});
