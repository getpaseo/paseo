import { describe, expect, it } from "vitest";
import { recoverWorkspaceSelection, resolveWorkspaceRecoveryModel } from "./model";

describe("resolveWorkspaceRecoveryModel", () => {
  it("keeps newer recovery actions visible but non-actionable", () => {
    expect(
      resolveWorkspaceRecoveryModel({
        enabled: true,
        connected: true,
        hasClient: true,
        hasServerInfo: true,
        supportsRecovery: true,
        inspection: {
          pending: false,
          error: null,
          data: {
            kind: "recoverable",
            workspaceId: "workspace-1",
            workspaceName: "Feature branch",
            action: "repair_from_snapshot",
            branch: "feature",
          },
        },
        restore: { pending: false, error: null },
      }),
    ).toEqual({
      kind: "unsupportedAction",
      action: "repair_from_snapshot",
    });
  });
});

describe("recoverWorkspaceSelection", () => {
  it("restores the workspace and selected archived agent as one recovery action", async () => {
    const operations: string[] = [];

    await recoverWorkspaceSelection({
      recoveryKey: "server-1:workspace-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      client: {
        restoreWorkspace: async (workspaceId) => {
          operations.push(`workspace:${workspaceId}`);
        },
        refreshAgent: async (agentId) => {
          operations.push(`agent:${agentId}`);
        },
      },
    });

    expect(operations).toEqual(["workspace:workspace-1", "agent:agent-1"]);
  });

  it("coalesces concurrent recovery and refresh for one workspace", async () => {
    let finishRestore!: () => void;
    const restore = new Promise<void>((resolve) => {
      finishRestore = resolve;
    });
    const operations: string[] = [];
    const client = {
      restoreWorkspace: async (workspaceId: string) => {
        operations.push(`workspace:${workspaceId}`);
        await restore;
      },
      refreshAgent: async (agentId: string) => {
        operations.push(`agent:${agentId}`);
      },
    };

    const first = recoverWorkspaceSelection({
      client,
      recoveryKey: "server-1:workspace-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
    });
    const second = recoverWorkspaceSelection({
      client,
      recoveryKey: "server-1:workspace-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
    });
    finishRestore();
    await Promise.all([first, second]);

    expect(operations).toEqual(["workspace:workspace-1", "agent:agent-1"]);
  });
});
