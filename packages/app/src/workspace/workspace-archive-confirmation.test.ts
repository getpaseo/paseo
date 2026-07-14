import { describe, expect, it } from "vitest";
import { resolveWorkspaceArchiveConfirmationKind } from "@/workspace/workspace-archive-confirmation";

describe("resolveWorkspaceArchiveConfirmationKind", () => {
  it("requires the chat confirmation for a chat workspace regardless of workspaceKind", () => {
    expect(
      resolveWorkspaceArchiveConfirmationKind({
        isChatWorkspace: true,
        workspaceKind: "local_checkout",
      }),
    ).toBe("chat");
    expect(
      resolveWorkspaceArchiveConfirmationKind({
        isChatWorkspace: true,
        workspaceKind: "worktree",
      }),
    ).toBe("chat");
  });

  it("requires the worktree risk confirmation for a non-chat worktree", () => {
    expect(
      resolveWorkspaceArchiveConfirmationKind({
        isChatWorkspace: false,
        workspaceKind: "worktree",
      }),
    ).toBe("worktree");
  });

  it("requires no confirmation for a non-chat, non-worktree workspace", () => {
    expect(
      resolveWorkspaceArchiveConfirmationKind({
        isChatWorkspace: false,
        workspaceKind: "local_checkout",
      }),
    ).toBe("none");
    expect(
      resolveWorkspaceArchiveConfirmationKind({
        isChatWorkspace: false,
        workspaceKind: "directory",
      }),
    ).toBe("none");
  });
});
