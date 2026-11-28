import { describe, expect, it, vi } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  registerLinkedProject,
  resolveWorkspaceDeepLinkAction,
} from "./workspace-navigation-model";

const target = { serverId: "srv_devbox", path: "/home/mo/worktree" };

it.each([
  { approved: false, current: true, writes: 0 },
  { approved: true, current: false, writes: 0 },
  { approved: true, current: true, writes: 1 },
])("registers only an approved, current link (%o)", async ({ approved, current, writes }) => {
  const register = vi.fn(async () => true);
  await registerLinkedProject({
    confirm: async () => approved,
    isCurrent: () => current,
    register,
  });
  expect(register).toHaveBeenCalledTimes(writes);
});

function workspace(input: { id: string; directory: string }): WorkspaceDescriptor {
  return { id: input.id, workspaceDirectory: input.directory } as WorkspaceDescriptor;
}

describe("workspace deep-link action", () => {
  it("requires an exact saved server identity before using the path", () => {
    expect(
      resolveWorkspaceDeepLinkAction({
        target,
        hostExists: false,
        directoryReady: true,
        workspaces: [workspace({ id: "workspace-1", directory: target.path })],
      }),
    ).toEqual({ kind: "connect-host" });
  });

  it("opens only an exact authoritative workspace-directory match", () => {
    expect(
      resolveWorkspaceDeepLinkAction({
        target,
        hostExists: true,
        directoryReady: true,
        workspaces: [
          workspace({ id: "wrong", directory: "/home/mo/worktree-copy" }),
          workspace({ id: "exact", directory: target.path }),
        ],
      }),
    ).toEqual({ kind: "open-workspace", workspaceId: "exact" });
  });

  it("registers the exact path as a project without creating an agent", () => {
    expect(
      resolveWorkspaceDeepLinkAction({
        target,
        hostExists: true,
        directoryReady: true,
        workspaces: [],
      }),
    ).toEqual({
      kind: "register-project",
    });
  });

  it("waits for the directory before deciding that a workspace is absent", () => {
    expect(
      resolveWorkspaceDeepLinkAction({
        target,
        hostExists: true,
        directoryReady: false,
        workspaces: [],
      }),
    ).toEqual({ kind: "wait-for-directory" });
  });
});
