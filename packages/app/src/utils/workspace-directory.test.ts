import { describe, expect, it } from "vitest";
import { requireWorkspaceDirectory, resolveWorkspaceDirectory } from "./workspace-directory";

describe("resolveWorkspaceDirectory", () => {
  it("canonicalizes a workspace directory and returns null when blank", () => {
    expect(resolveWorkspaceDirectory({ workspaceDirectory: "C:\\repo\\app\\" })).toBe(
      "C:/repo/app",
    );
    expect(resolveWorkspaceDirectory({ workspaceDirectory: "   " })).toBeNull();
  });
});

describe("requireWorkspaceDirectory", () => {
  it("returns the canonical directory when present", () => {
    expect(requireWorkspaceDirectory({ workspaceDirectory: "/repo/app/" })).toBe("/repo/app");
  });

  it("throws naming the workspace when the directory is missing", () => {
    expect(() =>
      requireWorkspaceDirectory({ workspaceId: "wks_1", workspaceDirectory: "  " }),
    ).toThrow("Workspace directory is missing for workspace wks_1");
  });
});
