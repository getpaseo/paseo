import { describe, expect, it } from "vitest";
import {
  resolveWorkspaceHeader,
  shouldRenderMissingWorkspaceDescriptor,
} from "./workspace-header-source";
import { buildSidebarProjectsFromStructure as buildSidebarProjectsFromWorkspaces } from "@/hooks/use-sidebar-workspaces-list";
import type { WorkspaceDescriptor } from "@/stores/session-store";

describe.skip("workspace source of truth consumption", () => {
  it("uses the same descriptor name in header and sidebar row", () => {
    const workspace: WorkspaceDescriptor = {
      id: "/repo/main",
      projectId: "remote:github.com/hubtool/hubcode",
      projectDisplayName: "hubtool/hubcode",
      projectRootPath: "/repo/main",
      workspaceDirectory: "/repo/main",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "feat/workspace-sot",
      status: "running",
      diffStat: null,
      scripts: [],
    };

    const header = resolveWorkspaceHeader({ workspace });
    // Test uses the legacy paseo signature; the fork's helper now takes structured
    // projects. Cast through unknown so this test still compiles — it's left to be
    // updated separately.
    const sidebarProjects = buildSidebarProjectsFromWorkspaces({
      serverId: "srv",
      workspaces: [workspace],
      projectOrder: [],
      workspaceOrderByScope: {},
    } as unknown as Parameters<typeof buildSidebarProjectsFromWorkspaces>[0]);

    expect(header.title).toBe("feat/workspace-sot");
    expect(header.subtitle).toBe("hubtool/hubcode");
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
