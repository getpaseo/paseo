import { describe, expect, it } from "vitest";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { selectActiveWorkspaceTabs } from "./active-workspace-tabs-model";

function workspace(input: { id: string; project?: string; name?: string }): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: `project-${input.id}`,
    projectDisplayName: input.project ?? "Client",
    projectCustomName: null,
    projectRootPath: `/code/${input.id}`,
    workspaceDirectory: `/code/${input.id}`,
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: input.name ?? input.id,
    title: null,
    status: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

function agent(input: {
  id: string;
  workspaceId: string;
  status: Agent["status"];
  permission?: boolean;
  archived?: boolean;
  lastActivityAt?: number;
}): Agent {
  const now = new Date(input.lastActivityAt ?? 1);
  return {
    serverId: "local",
    id: input.id,
    provider: "claude",
    status: input.status,
    createdAt: now,
    updatedAt: now,
    lastUserMessageAt: null,
    lastActivityAt: now,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: input.permission
      ? ([{ id: "permission" }] as Agent["pendingPermissions"])
      : [],
    persistence: null,
    title: input.id,
    cwd: `/code/${input.workspaceId}`,
    workspaceId: input.workspaceId,
    model: null,
    attentionReason: input.permission ? "permission" : null,
    attentionTimestamp: input.permission ? now : null,
    archivedAt: input.archived ? now : null,
    parentAgentId: null,
    labels: {},
  };
}

describe("active-workspace-tabs-model", () => {
  it("shows only workspaces containing running or actionable sessions", () => {
    const active = workspace({ id: "active", project: "Acme", name: "API" });
    const idle = workspace({ id: "idle", project: "Acme", name: "Web" });

    const tabs = selectActiveWorkspaceTabs({
      sessions: {
        local: {
          workspaces: new Map([
            [active.id, active],
            [idle.id, idle],
          ]),
          agents: new Map([
            ["running", agent({ id: "running", workspaceId: active.id, status: "running" })],
            ["idle", agent({ id: "idle", workspaceId: idle.id, status: "idle" })],
          ]),
        },
      },
    });

    expect(tabs.map((tab) => tab.key)).toEqual(["local:active"]);
    expect(tabs[0]?.sessions.map((session) => session.agentId)).toEqual(["running"]);
  });

  it("prioritizes waiting sessions and excludes archived sessions", () => {
    const current = workspace({ id: "workspace" });

    const tabs = selectActiveWorkspaceTabs({
      sessions: {
        local: {
          workspaces: new Map([[current.id, current]]),
          agents: new Map([
            [
              "running",
              agent({
                id: "running",
                workspaceId: current.id,
                status: "running",
                lastActivityAt: 3,
              }),
            ],
            [
              "waiting",
              agent({
                id: "waiting",
                workspaceId: current.id,
                status: "idle",
                permission: true,
                lastActivityAt: 2,
              }),
            ],
            [
              "archived",
              agent({
                id: "archived",
                workspaceId: current.id,
                status: "running",
                archived: true,
                lastActivityAt: 4,
              }),
            ],
          ]),
        },
      },
    });

    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.status).toBe("needs_input");
    expect(tabs[0]?.needsInputCount).toBe(1);
    expect(tabs[0]?.sessions.map((session) => session.agentId)).toEqual(["waiting", "running"]);
  });
});
