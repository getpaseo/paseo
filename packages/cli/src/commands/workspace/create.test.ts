import { describe, expect, it } from "vitest";
import { buildWorkspaceSource } from "./create.js";

describe("workspace create source", () => {
  it("maps local isolation to a directory workspace", () => {
    expect(
      buildWorkspaceSource({ isolation: "local", path: "/tmp/project", project: "project-1" }),
    ).toEqual({ kind: "directory", path: "/tmp/project", projectId: "project-1" });
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

  it("maps chat flag or isolation to a chat workspace", () => {
    expect(buildWorkspaceSource({ chat: true })).toEqual({ kind: "chat" });
    expect(buildWorkspaceSource({ isolation: "chat" })).toEqual({ kind: "chat" });
    expect(
      buildWorkspaceSource({
        chat: true,
        chatsDir: "/custom/chats",
        sessionId: "session-123",
      }),
    ).toEqual({
      kind: "chat",
      chatsDirectory: "/custom/chats",
      sessionId: "session-123",
    });
  });

  it("rejects chat flag combined with conflicting isolation", () => {
    expect(() =>
      buildWorkspaceSource({ chat: true, isolation: "worktree", branch: "feature" }),
    ).toThrow("--chat cannot be combined with --isolation worktree");
  });

  it("rejects worktree or local options for chat workspaces", () => {
    expect(() => buildWorkspaceSource({ chat: true, branch: "feature" })).toThrow(
      "Chat workspaces do not support worktree, branch, project, or path options",
    );
    expect(() => buildWorkspaceSource({ isolation: "chat", path: "/tmp/project" })).toThrow(
      "Chat workspaces do not support worktree, branch, project, or path options",
    );
    expect(() => buildWorkspaceSource({ chat: true, project: "my-project" })).toThrow(
      "Chat workspaces do not support worktree, branch, project, or path options",
    );
  });

  it("rejects chats-dir or session-id without chat flag or isolation", () => {
    expect(() => buildWorkspaceSource({ isolation: "local", chatsDir: "/tmp/chats" })).toThrow(
      "--chats-dir and --session-id require --chat or --isolation chat",
    );
    expect(() => buildWorkspaceSource({ isolation: "worktree", sessionId: "my-session" })).toThrow(
      "--chats-dir and --session-id require --chat or --isolation chat",
    );
  });
});
