import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

import {
  resolveWorkspaceHeader,
  resolveWorkspaceHeaderRenderState,
  shouldRenderMissingWorkspaceDescriptor,
} from "./workspace-header-source";
import { createSidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { WorkspaceDescriptor } from "@/stores/session-store";

function createWorkspaceDescriptor(input: Partial<WorkspaceDescriptor> = {}): WorkspaceDescriptor {
  return {
    id: "/repo/main",
    projectId: "remote:github.com/getpaseo/paseo",
    projectDisplayName: "getpaseo/paseo",
    projectRootPath: "/repo/main",
    workspaceDirectory: "/repo/main",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "feat/workspace-sot",
    status: "running",
    diffStat: null,
    scripts: [],
    ...input,
    archivingAt: input.archivingAt ?? null,
  };
}

describe("workspace source of truth consumption", () => {
  it("uses the same descriptor name in header and sidebar row", () => {
    const workspace = createWorkspaceDescriptor();

    const header = resolveWorkspaceHeader({ workspace });
    const sidebarWorkspace = createSidebarWorkspaceEntry({
      serverId: "srv",
      workspace,
    });

    expect(header.title).toBe("feat/workspace-sot");
    expect(header.subtitle).toBe("getpaseo/paseo");
    expect(sidebarWorkspace.name).toBe(header.title);
    expect(sidebarWorkspace.statusBucket).toBe("running");
  });

  it("keeps the header skeleton while the workspace descriptor is missing", () => {
    expect(
      resolveWorkspaceHeaderRenderState({
        workspace: null,
        checkoutState: { kind: "pending" },
      }),
    ).toEqual({ kind: "skeleton" });
  });

  it("keeps git workspace headers skeletoned until checkout status resolves", () => {
    expect(
      resolveWorkspaceHeaderRenderState({
        workspace: createWorkspaceDescriptor({ projectKind: "git" }),
        checkoutState: { kind: "pending" },
      }),
    ).toEqual({ kind: "skeleton" });
  });

  it("renders known non-git workspace identity while checkout status is pending", () => {
    expect(
      resolveWorkspaceHeaderRenderState({
        workspace: createWorkspaceDescriptor({
          projectKind: "non_git",
          workspaceKind: "directory",
          name: "notes",
          projectDisplayName: "Local folders",
        }),
        checkoutState: { kind: "pending" },
      }),
    ).toEqual({
      kind: "ready",
      title: "notes",
      subtitle: "Local folders",
      shouldShowSubtitle: true,
      isGitCheckout: false,
      currentBranchName: null,
    });
  });

  it("renders git checkout headers with branch affordance after checkout status resolves", () => {
    expect(
      resolveWorkspaceHeaderRenderState({
        workspace: createWorkspaceDescriptor(),
        checkoutState: {
          kind: "ready",
          checkout: { isGit: true, currentBranch: "feat/workspace-sot" },
        },
      }),
    ).toEqual({
      kind: "ready",
      title: "feat/workspace-sot",
      subtitle: "getpaseo/paseo",
      shouldShowSubtitle: true,
      isGitCheckout: true,
      currentBranchName: "feat/workspace-sot",
    });
  });

  it("renders non-git checkout headers without branch affordance after checkout status resolves", () => {
    expect(
      resolveWorkspaceHeaderRenderState({
        workspace: createWorkspaceDescriptor({
          projectKind: "non_git",
          workspaceKind: "directory",
          name: "notes",
          projectDisplayName: "notes",
        }),
        checkoutState: {
          kind: "ready",
          checkout: { isGit: false, currentBranch: null },
        },
      }),
    ).toEqual({
      kind: "ready",
      title: "notes",
      subtitle: "notes",
      shouldShowSubtitle: false,
      isGitCheckout: false,
      currentBranchName: null,
    });
  });

  it("renders descriptor identity after checkout status errors", () => {
    expect(
      resolveWorkspaceHeaderRenderState({
        workspace: createWorkspaceDescriptor(),
        checkoutState: { kind: "error" },
      }),
    ).toEqual({
      kind: "ready",
      title: "feat/workspace-sot",
      subtitle: "getpaseo/paseo",
      shouldShowSubtitle: true,
      isGitCheckout: false,
      currentBranchName: null,
    });
  });

  it("renders explicit missing state only after workspace hydration", () => {
    expect(
      shouldRenderMissingWorkspaceDescriptor({
        workspace: null,
        hasHydratedWorkspaces: true,
      }),
    ).toBe(true);

    expect(
      shouldRenderMissingWorkspaceDescriptor({
        workspace: null,
        hasHydratedWorkspaces: false,
      }),
    ).toBe(false);
  });

  describe("worktree slug in sidebar entry", () => {
    it("sets worktreeSlug for worktree workspace with worktree path", () => {
      const sidebar = createSidebarWorkspaceEntry({
        serverId: "srv",
        workspace: createWorkspaceDescriptor({
          workspaceKind: "worktree",
          workspaceDirectory: "/Users/dev/.paseo/worktrees/a1b2c3d4/puny-impala",
          name: "feat/login",
        }),
      });
      expect(sidebar.worktreeSlug).toBe("puny-impala");
    });

    it("sets worktreeSlug to null for non-worktree workspace even with worktree-like path", () => {
      const sidebar = createSidebarWorkspaceEntry({
        serverId: "srv",
        workspace: createWorkspaceDescriptor({
          workspaceKind: "local_checkout",
          workspaceDirectory: "/Users/dev/.paseo/worktrees/a1b2c3d4/puny-impala",
          name: "feat/login",
        }),
      });
      expect(sidebar.worktreeSlug).toBeNull();
    });

    it("sets worktreeSlug to null for worktree workspace with non-worktree path", () => {
      const sidebar = createSidebarWorkspaceEntry({
        serverId: "srv",
        workspace: createWorkspaceDescriptor({
          workspaceKind: "worktree",
          workspaceDirectory: "/Users/dev/projects/my-app",
          name: "feat/login",
        }),
      });
      expect(sidebar.worktreeSlug).toBeNull();
    });

    it("sets worktreeSlug to null when workspaceDirectory is undefined", () => {
      const sidebar = createSidebarWorkspaceEntry({
        serverId: "srv",
        workspace: createWorkspaceDescriptor({
          workspaceKind: "worktree",
          workspaceDirectory: undefined,
          name: "feat/login",
        }),
      });
      expect(sidebar.worktreeSlug).toBeNull();
    });
  });

  describe("worktree slug in workspace header", () => {
    it("resolveWorkspaceHeaderRenderState still returns correct branch for worktree workspace", () => {
      const state = resolveWorkspaceHeaderRenderState({
        workspace: createWorkspaceDescriptor({
          workspaceKind: "worktree",
          workspaceDirectory: "/Users/dev/.paseo/worktrees/a1b2c3d4/puny-impala",
          name: "feat/login",
        }),
        checkoutState: {
          kind: "ready",
          checkout: { isGit: true, currentBranch: "feat/login" },
        },
      });
      expect(state.kind).toBe("ready");
      if (state.kind === "ready") {
        expect(state.currentBranchName).toBe("feat/login");
      }
    });

    it("resolveWorkspaceHeaderRenderState handles non-worktree workspace with worktree-like path", () => {
      const state = resolveWorkspaceHeaderRenderState({
        workspace: createWorkspaceDescriptor({
          workspaceKind: "local_checkout",
          workspaceDirectory: "/Users/dev/.paseo/worktrees/a1b2c3d4/puny-impala",
          name: "feat/login",
        }),
        checkoutState: {
          kind: "ready",
          checkout: { isGit: true, currentBranch: "feat/login" },
        },
      });
      expect(state.kind).toBe("ready");
      if (state.kind === "ready") {
        expect(state.currentBranchName).toBe("feat/login");
      }
    });
  });
});
