import { describe, expect, it } from "vitest";
import type { WorkspaceDraftTabSetup } from "@/stores/workspace-tabs-store";
import { remapWorkspaceDraftSetupForWorkspace } from "./draft-setup";

function setup(cwd: string): WorkspaceDraftTabSetup {
  return {
    provider: "codex",
    cwd,
    modeId: "code",
    model: "gpt-5",
    thinkingOptionId: "high",
    featureValues: { webSearch: true },
  };
}

describe("remapWorkspaceDraftSetupForWorkspace", () => {
  it("maps a source-agent subdirectory into the created workspace", () => {
    expect(
      remapWorkspaceDraftSetupForWorkspace({
        setup: setup("/repo/packages/app"),
        sourceDirectory: "/repo",
        workspaceDirectory: "/tmp/worktrees/fork-1",
      }),
    ).toEqual({
      ...setup("/repo/packages/app"),
      cwd: "/tmp/worktrees/fork-1/packages/app",
    });
  });

  it("uses the created workspace root when the source agent ran at the source root", () => {
    expect(
      remapWorkspaceDraftSetupForWorkspace({
        setup: setup("/repo/"),
        sourceDirectory: "/repo",
        workspaceDirectory: "/tmp/worktrees/fork-1",
      }).cwd,
    ).toBe("/tmp/worktrees/fork-1");
  });

  it("falls back to the workspace root when the cwd is outside the source directory", () => {
    expect(
      remapWorkspaceDraftSetupForWorkspace({
        setup: setup("/other/repo"),
        sourceDirectory: "/repo",
        workspaceDirectory: "/tmp/worktrees/fork-1",
      }).cwd,
    ).toBe("/tmp/worktrees/fork-1");
  });

  it("preserves a Windows-style output separator", () => {
    expect(
      remapWorkspaceDraftSetupForWorkspace({
        setup: setup("C:\\repo\\packages\\app"),
        sourceDirectory: "C:\\repo",
        workspaceDirectory: "C:\\worktrees\\fork-1",
      }).cwd,
    ).toBe("C:\\worktrees\\fork-1\\packages\\app");
  });
});
