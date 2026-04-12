import { describe, expect, it } from "vitest";
import {
  resolveWorkspaceHeader,
  shouldRenderMissingWorkspaceDescriptor,
} from "./workspace-header-source";
import { buildSidebarProjectsFromWorkspaces } from "@/hooks/use-sidebar-workspaces-list";
import type { WorkspaceDescriptor } from "@/stores/session-store";

describe("workspace source of truth consumption", () => {
  it("uses the same descriptor name in header and sidebar row", () => {
    const workspace: WorkspaceDescriptor = {
      id: "/repo/main",
      projectId: "remote:github.com/getpaseo/paseo",
      projectDisplayName: "getpaseo/paseo",
      projectRootPath: "/repo/main",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "feat/workspace-sot",
      status: "running",
      diffStat: null,
    };

    const header = resolveWorkspaceHeader({ workspace });
    const sidebarProjects = buildSidebarProjectsFromWorkspaces({
      serverId: "srv",
      workspaces: [workspace],
      projectOrder: [],
      workspaceOrderByScope: {},
    });

    expect(header.title).toBe("feat/workspace-sot");
    expect(header.subtitle).toBe("getpaseo/paseo");
    expect(sidebarProjects[0]?.workspaces[0]?.name).toBe(header.title);
    expect(sidebarProjects[0]?.workspaces[0]?.statusBucket).toBe("running");
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
});
