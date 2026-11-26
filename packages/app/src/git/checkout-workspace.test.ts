import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { resolveCheckoutWorkspaceId } from "@/git/checkout-workspace";

function workspace(id: string, workspaceDirectory: string): WorkspaceDescriptor {
  return { id, workspaceDirectory } as WorkspaceDescriptor;
}

describe("resolveCheckoutWorkspaceId", () => {
  const local = workspace("wks_local", "/repo");
  const sandboxed = workspace("wks_sandboxed", "/repo");
  const feature = workspace("wks_feature", "/repo/.paseo/worktrees/feature");
  const workspaces = new Map([
    [local.id, local],
    [sandboxed.id, sandboxed],
    [feature.id, feature],
  ]);

  it("names the active workspace when it is on the checkout", () => {
    const active = { serverId: "srv", workspaceId: "wks_sandboxed" };
    expect(
      resolveCheckoutWorkspaceId({ workspaces, activeWorkspaceSelection: active, cwd: "/repo" }),
    ).toBe("wks_sandboxed");
  });

  it("names the only workspace on a checkout, and guesses none on a shared one", () => {
    const elsewhere = { serverId: "srv", workspaceId: "wks_feature" };
    expect(
      resolveCheckoutWorkspaceId({
        workspaces,
        activeWorkspaceSelection: null,
        cwd: "/repo/.paseo/worktrees/feature",
      }),
    ).toBe("wks_feature");
    expect(
      resolveCheckoutWorkspaceId({ workspaces, activeWorkspaceSelection: elsewhere, cwd: "/repo" }),
    ).toBeUndefined();
  });
});
