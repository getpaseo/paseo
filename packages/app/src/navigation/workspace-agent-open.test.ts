import { describe, expect, it } from "vitest";
import { normalizeWorkspaceDescriptor } from "@/stores/session-store";
import { resolveWorkspaceAgentOpen, type WorkspaceAgentOpenInput } from "./workspace-agent-open";

function createInput(): WorkspaceAgentOpenInput {
  const workspace = normalizeWorkspaceDescriptor({
    id: "workspace-a",
    projectId: "project-1",
    projectDisplayName: "Paseo",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo/workspace-a",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "main",
    status: "done",
    statusEnteredAt: null,
    activityAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  });
  return {
    serverId: "server-1",
    workspaceId: workspace.id,
    openValue: "agent:agent-1",
    agentTarget: { agentWorkspaceId: workspace.id, isCurrent: false },
    isConnected: false,
    hasCurrentAgentDirectory: false,
    hasHydratedWorkspaces: false,
    workspaces: new Map([
      [workspace.id, workspace],
      ["workspace-b", { ...workspace, id: "workspace-b", workspaceDirectory: "/repo/workspace-b" }],
    ]),
  };
}

describe("workspace agent open intent", () => {
  it("opens a cached workspace while offline and retains the intent", () => {
    expect(resolveWorkspaceAgentOpen(createInput())).toEqual({ kind: "openCached" });
  });

  it("waits for ownership after the host reconnects even when the workspace is cached", () => {
    expect(
      resolveWorkspaceAgentOpen({
        ...createInput(),
        isConnected: true,
        hasHydratedWorkspaces: true,
      }),
    ).toEqual({ kind: "waiting" });
  });

  it("corrects the retained intent when refreshed ownership names a different workspace", () => {
    expect(
      resolveWorkspaceAgentOpen({
        ...createInput(),
        isConnected: true,
        hasCurrentAgentDirectory: true,
        hasHydratedWorkspaces: true,
        agentTarget: { agentWorkspaceId: "workspace-b", isCurrent: true },
      }),
    ).toEqual({
      kind: "redirect",
      route: "/h/server-1/workspace/workspace-b?open=agent%3Aagent-1",
    });
  });

  it("does not redirect using cached ownership after a workspace refresh alone", () => {
    expect(
      resolveWorkspaceAgentOpen({
        ...createInput(),
        isConnected: true,
        hasHydratedWorkspaces: true,
        agentTarget: { agentWorkspaceId: "workspace-b", isCurrent: false },
      }),
    ).toEqual({ kind: "waiting" });
  });

  it("waits for workspace refresh before trusting a cached workspace map", () => {
    expect(
      resolveWorkspaceAgentOpen({
        ...createInput(),
        isConnected: true,
        hasCurrentAgentDirectory: true,
        agentTarget: { agentWorkspaceId: "workspace-b", isCurrent: true },
      }),
    ).toEqual({ kind: "waiting" });
  });

  it("keeps the intent when refreshed ownership arrives before its workspace", () => {
    expect(
      resolveWorkspaceAgentOpen({
        ...createInput(),
        isConnected: true,
        hasCurrentAgentDirectory: true,
        hasHydratedWorkspaces: true,
        agentTarget: { agentWorkspaceId: "workspace-new", isCurrent: true },
      }),
    ).toEqual({ kind: "waiting" });
  });

  it("opens and consumes the intent after both directories are current", () => {
    expect(
      resolveWorkspaceAgentOpen({
        ...createInput(),
        isConnected: true,
        hasCurrentAgentDirectory: true,
        hasHydratedWorkspaces: true,
        agentTarget: { agentWorkspaceId: "workspace-a", isCurrent: true },
      }),
    ).toEqual({ kind: "openCurrent" });
  });

  it("opens an archived agent's supplied workspace after directory refresh", () => {
    expect(
      resolveWorkspaceAgentOpen({
        ...createInput(),
        isConnected: true,
        hasCurrentAgentDirectory: true,
        hasHydratedWorkspaces: true,
        agentTarget: { agentWorkspaceId: undefined, isCurrent: false },
      }),
    ).toEqual({ kind: "openCurrent" });
  });

  it("keeps waiting for a missing archived workspace to be restored", () => {
    expect(
      resolveWorkspaceAgentOpen({
        ...createInput(),
        workspaceId: "workspace-archived",
        isConnected: true,
        hasCurrentAgentDirectory: true,
        hasHydratedWorkspaces: true,
        agentTarget: { agentWorkspaceId: undefined, isCurrent: false },
      }),
    ).toEqual({ kind: "waiting" });
  });

  it("recovers a missing payload workspace when current ownership resolves elsewhere", () => {
    expect(
      resolveWorkspaceAgentOpen({
        ...createInput(),
        workspaceId: "workspace-missing",
        isConnected: true,
        hasCurrentAgentDirectory: true,
        hasHydratedWorkspaces: true,
        agentTarget: { agentWorkspaceId: "workspace-b", isCurrent: true },
      }),
    ).toEqual({
      kind: "redirect",
      route: "/h/server-1/workspace/workspace-b?open=agent%3Aagent-1",
    });
  });

  it("keeps a missing offline workspace pending instead of opening a nonexistent tab", () => {
    expect(
      resolveWorkspaceAgentOpen({
        ...createInput(),
        workspaces: new Map(),
      }),
    ).toEqual({ kind: "waiting" });
  });
});
