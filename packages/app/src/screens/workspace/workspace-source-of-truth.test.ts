import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

import {
  resolveWorkspaceHeader,
  shouldRenderMissingWorkspaceDescriptor,
} from "./workspace-header-source";
import { createSidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { WorkspaceDescriptor } from "@/stores/session-store";

describe("workspace source of truth consumption", () => {
  it("uses the same descriptor name in header and sidebar row", () => {
    const workspace: WorkspaceDescriptor = {
      id: "/repo/main",
      projectId: "remote:github.com/getpaseo/paseo",
      projectDisplayName: "getpaseo/paseo",
      projectRootPath: "/repo/main",
      workspaceDirectory: "/repo/main",
      projectKind: "git",
      workspaceKind: "checkout",
      name: "feat/workspace-sot",
      status: "running",
      diffStat: null,
      scripts: [],
    };

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
