import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  createMacDockBadgeCountSelector,
  isWorkspaceActionableForDesktopBadge,
  selectMacDockBadgeCount,
} from "./desktop-badge-state";

function workspace(id: string, status: WorkspaceDescriptor["status"]): WorkspaceDescriptor {
  return {
    createdAt: null,
    lastUserMessageAt: null,
    id,
    projectId: "project-1",
    projectDisplayName: "Project 1",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: id,
    status,
    archivingAt: null,
    statusEnteredAt: null,
    diffStat: null,
    scripts: [],
  };
}

function stateWith(...workspaces: WorkspaceDescriptor[]) {
  return {
    sessions: {
      srv_a: { workspaces: new Map(workspaces.map((entry) => [entry.id, entry])) },
    },
  };
}

describe("desktop-badge-state", () => {
  it("treats attention-requiring workspace statuses as actionable", () => {
    expect(isWorkspaceActionableForDesktopBadge("attention")).toBe(true);
    expect(isWorkspaceActionableForDesktopBadge("needs_input")).toBe(true);
    expect(isWorkspaceActionableForDesktopBadge("failed")).toBe(true);
  });

  it("ignores running and done workspace statuses", () => {
    expect(isWorkspaceActionableForDesktopBadge("running")).toBe(false);
    expect(isWorkspaceActionableForDesktopBadge("done")).toBe(false);
  });

  it("returns undefined when no visible workspaces need attention", () => {
    expect(
      selectMacDockBadgeCount(stateWith(workspace("a", "done"), workspace("b", "running"))),
    ).toBeUndefined();
  });

  it("counts only actionable visible workspaces across every host", () => {
    const state = {
      sessions: {
        srv_a: {
          workspaces: new Map([
            ["a", workspace("a", "done")],
            ["b", workspace("b", "attention")],
          ]),
        },
        srv_b: {
          workspaces: new Map([
            ["c", workspace("c", "running")],
            ["d", workspace("d", "needs_input")],
            ["e", workspace("e", "failed")],
          ]),
        },
      },
    };
    expect(selectMacDockBadgeCount(state)).toBe(3);
  });

  it("recounts only when a workspace map is replaced", () => {
    const select = createMacDockBadgeCountSelector();
    const state = stateWith(workspace("a", "attention"));
    expect(select(state)).toBe(1);

    state.sessions.srv_a.workspaces.set("b", workspace("b", "failed"));
    expect(select({ sessions: { ...state.sessions } })).toBe(1);

    expect(select(stateWith(workspace("a", "attention"), workspace("b", "failed")))).toBe(2);
  });
});
