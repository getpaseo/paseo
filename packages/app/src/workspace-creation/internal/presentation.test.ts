import { describe, expect, it } from "vitest";
import { createWorkspaceCreationModel } from "../model";
import {
  includeCreatingAgent,
  pendingCreationAgent,
  workspaceCreationPresentation,
} from "../presentation";
import { addCreatingSidebarWorkspaces } from "../presentation";
import {
  buildWorkspaceTabSnapshot,
  deriveWorkspaceAgentVisibility,
} from "@/workspace-tabs/agent-visibility";
import { createWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { SidebarWorkspacePlacementModel } from "@/hooks/sidebar-workspaces-view-model";

function pendingCreation() {
  let finish!: () => void;
  const response = new Promise<{}>((resolve) => {
    finish = () => resolve({});
  });
  const model = createWorkspaceCreationModel({
    identities: () => ({
      operationKey: "operation",
      workspaceId: "wks_0123456789abcdef",
      agentId: "reserved-agent",
      clientMessageId: "message",
    }),
    execute: async () => response,
  });
  const attempt = model.submit({
    serverId: "host",
    key: "draft",
    projectId: "project",
    projectName: "Project",
    provider: "mock",
    config: { model: "e2e-fast-stream", modeId: "load-test" },
    text: "My pending prompt",
    prepare: async () => ({
      source: { kind: "directory", path: "/project" },
      agent: { config: { provider: "mock", cwd: "/project" }, initialPrompt: "My pending prompt" },
    }),
  });
  return { model, attempt, finish };
}

describe("creation presentation across directory replacement", () => {
  it("keeps the final agent tab through empty snapshots and releases it to ordinary archive rules after completion", async () => {
    const { model, attempt, finish } = pendingCreation();
    let next = 0;
    const layouts = createWorkspaceLayoutStore({
      createNodeId: (prefix) => `${prefix}_${++next}`,
      createFocusRestorationToken: () => `focus-${++next}`,
    });
    const workspaceKey = `host:${attempt.workspaceId}`;
    const tabId = layouts.getState().openTab({
      workspaceKey,
      target: { kind: "agent", agentId: attempt.agentId },
      intent: "reveal",
    });
    const reconcileEmptyDirectory = () =>
      layouts.getState().reconcileTabs(
        workspaceKey,
        buildWorkspaceTabSnapshot({
          agentVisibility: includeCreatingAgent(
            deriveWorkspaceAgentVisibility({
              sessionAgents: new Map(),
              workspaceId: attempt.workspaceId,
            }),
            model.getWorkspace("host", attempt.workspaceId),
          ),
          agentsHydrated: true,
          terminalsHydrated: true,
          knownTerminalIds: [],
          standaloneTerminalIds: [],
          hasActivePendingTerminalCreate: false,
          hasActivePendingDraftCreate: false,
        }),
      );
    reconcileEmptyDirectory();
    model.observeResources("host", new Set([attempt.workspaceId]), new Set([attempt.agentId]));
    reconcileEmptyDirectory();
    expect(
      layouts
        .getState()
        .getWorkspaceTabs(workspaceKey)
        .filter((tab) => tab.target.kind === "agent")
        .map((tab) => tab.tabId),
    ).toEqual([tabId]);
    finish();
    await model.settled(attempt);
    reconcileEmptyDirectory();
    expect(
      layouts
        .getState()
        .getWorkspaceTabs(workspaceKey)
        .filter((tab) => tab.target.kind === "agent"),
    ).toEqual([]);
  });

  it("offers pending navigation without inventing an operational workspace directory", () => {
    const { attempt, finish } = pendingCreation();
    expect(workspaceCreationPresentation(null, attempt)).toEqual({
      workspacePending: true,
      exists: true,
      projectName: "Project",
      canInspectRecovery: false,
    });
    expect(attempt).not.toHaveProperty("workspaceDirectory");
    expect(attempt).not.toHaveProperty("capabilities");
    // The submitted config is displayable, but the source directory is not the destination.
    expect(pendingCreationAgent(attempt)).toMatchObject({
      id: "reserved-agent",
      provider: "mock",
      model: "e2e-fast-stream",
      currentModeId: "load-test",
      cwd: "",
      status: "running",
    });
    finish();
  });

  it("keeps one sidebar entry through refresh and hands it to the authoritative directory", async () => {
    const { model, attempt, finish } = pendingCreation();
    const directory: SidebarWorkspacePlacementModel = {
      projects: [
        {
          viewKey: "project",
          projectName: "Project",
          projectKind: "git",
          iconWorkingDir: "/project",
          hosts: [
            {
              serverId: "host",
              projectId: "project",
              iconWorkingDir: "/project",
              worktreeSupport: "supported",
            },
          ],
          workspaces: [],
        },
      ],
      workspaces: [],
      projectNamesByViewKey: new Map([["project", "Project"]]),
    };
    const first = addCreatingSidebarWorkspaces(directory, model.getSnapshot());
    const refreshed = addCreatingSidebarWorkspaces(
      { ...directory, workspaces: [] },
      model.getSnapshot(),
    );
    expect(first.workspaces).toEqual(refreshed.workspaces);
    expect(refreshed.workspaces).toHaveLength(1);
    expect(refreshed.workspaces[0]?.workspaceId).toBe(attempt.workspaceId);
    expect(refreshed.workspaces[0]?.workspaceDirectory).toBeUndefined();
    model.observeResources("host", new Set([attempt.workspaceId]), new Set());
    expect(addCreatingSidebarWorkspaces(first, model.getSnapshot()).workspaces).toHaveLength(1);
    finish();
    await model.settled(attempt);
  });
});
