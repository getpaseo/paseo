import { describe, expect, it } from "vitest";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import {
  getWorkspaceNamingAttachments,
  remapDraftCwdToWorkspace,
} from "./new-workspace-fork-context";

describe("remapDraftCwdToWorkspace", () => {
  it("preserves a Windows subdirectory when source path casing differs", () => {
    expect(
      remapDraftCwdToWorkspace({
        cwd: "c:\\Repo\\packages\\app",
        sourceDirectory: "C:\\Repo",
        workspaceDirectory: "D:\\Worktrees\\fork",
      }),
    ).toBe("D:\\Worktrees\\fork\\packages\\app");
  });

  it("falls back to the workspace root when the cwd is outside the source directory", () => {
    expect(
      remapDraftCwdToWorkspace({
        cwd: "/other/repo/packages/app",
        sourceDirectory: "/repo",
        workspaceDirectory: "/worktrees/fork",
      }),
    ).toBe("/worktrees/fork");
  });
});

describe("getWorkspaceNamingAttachments", () => {
  it("removes full chat history from workspace naming context", () => {
    const chatHistory = {
      type: "text",
      mimeType: "text/plain",
      contextKind: "chat_history",
      title: "Chat history",
      text: "Long prior conversation",
    } satisfies AgentAttachment;
    const prContext = {
      type: "github_pr",
      mimeType: "application/github-pr",
      number: 1788,
      title: "Fork assistant turns into new drafts",
      url: "https://github.com/getpaseo/paseo/pull/1788",
    } satisfies AgentAttachment;

    expect(getWorkspaceNamingAttachments([chatHistory, prContext])).toEqual([prContext]);
  });
});
