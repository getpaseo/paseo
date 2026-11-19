import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { resolveWorkspaceDeepLinkAction } from "./workspace-navigation-model";

const target = { serverId: "srv_devbox", path: "/home/mo/worktree" };

function workspace(input: { id: string; directory: string }): WorkspaceDescriptor {
  return { id: input.id, workspaceDirectory: input.directory } as WorkspaceDescriptor;
}

describe("workspace deep-link action", () => {
  it("requires an exact saved server identity before using the path", () => {
    expect(
      resolveWorkspaceDeepLinkAction({
        target,
        hostExists: false,
        workspaces: [workspace({ id: "workspace-1", directory: target.path })],
      }),
    ).toEqual({ kind: "connect-host" });
  });

  it("opens only an exact authoritative workspace-directory match", () => {
    expect(
      resolveWorkspaceDeepLinkAction({
        target,
        hostExists: true,
        workspaces: [
          workspace({ id: "wrong", directory: "/home/mo/worktree-copy" }),
          workspace({ id: "exact", directory: target.path }),
        ],
      }),
    ).toEqual({ kind: "open-workspace", workspaceId: "exact" });
  });

  it("registers the exact path as a project without creating an agent", () => {
    expect(resolveWorkspaceDeepLinkAction({ target, hostExists: true, workspaces: [] })).toEqual({
      kind: "register-project",
    });
  });
});
