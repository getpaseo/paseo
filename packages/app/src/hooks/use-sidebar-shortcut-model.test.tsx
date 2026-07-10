/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarShortcutModel } from "./use-sidebar-shortcut-model";

function workspace(projectKey: string, workspaceId: string): SidebarWorkspaceEntry {
  return {
    workspaceKey: `srv:${workspaceId}`,
    serverId: "srv",
    workspaceId,
    projectKey,
    projectName: projectKey,
    projectRootPath: `/repo/${projectKey}`,
    workspaceDirectory: `/repo/${projectKey}/${workspaceId}`,
    projectKind: "git",
    workspaceKind: "worktree",
    name: workspaceId,
    title: null,
    currentBranch: null,
    statusBucket: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
  };
}

function project(projectKey: string): SidebarProjectEntry {
  return {
    projectKey,
    projectName: projectKey,
    projectKind: "git",
    iconWorkingDir: `/repo/${projectKey}`,
    hosts: [],
    workspaces: [workspace(projectKey, `${projectKey}-main`)],
  };
}

const PROJECTS_BOTH = [project("p1"), project("p2")];
const PROJECTS_ONLY_SECOND = [project("p2")];

function Probe({ projectSet }: { projectSet: "both" | "onlySecond" }) {
  const projects = projectSet === "both" ? PROJECTS_BOTH : PROJECTS_ONLY_SECOND;
  useSidebarShortcutModel({ projects });
  return null;
}

describe("useSidebarShortcutModel", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useSidebarCollapsedSectionsStore.setState({
      collapsedProjectKeys: new Set(),
      collapsedStatusGroupKeys: new Set(),
    });
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
  });

  it("keeps a collapsed project collapsed when the project list temporarily omits it", async () => {
    useSidebarCollapsedSectionsStore.setState({
      collapsedProjectKeys: new Set(["p1"]),
    });

    await act(async () => {
      root?.render(<Probe projectSet="both" />);
    });
    await act(async () => {
      root?.render(<Probe projectSet="onlySecond" />);
    });
    await act(async () => {
      root?.render(<Probe projectSet="both" />);
    });

    expect(useSidebarCollapsedSectionsStore.getState().collapsedProjectKeys.has("p1")).toBe(true);
  });
});
