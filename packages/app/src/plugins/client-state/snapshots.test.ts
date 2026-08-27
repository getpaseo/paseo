import { describe, expect, it } from "vitest";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { createPluginAgentSnapshot, createPluginWorkspaceSnapshot } from "./snapshots";

const workspace: WorkspaceDescriptor = {
  id: "workspace-1",
  projectId: "project-1",
  projectDisplayName: "Paseo",
  projectRootPath: "/repo/paseo",
  workspaceDirectory: "/repo/paseo/review",
  projectKind: "git",
  workspaceKind: "worktree",
  name: "Review",
  title: "Plugin review",
  pinnedAt: null,
  status: "running",
  statusEnteredAt: new Date("2026-08-16T10:00:00.000Z"),
  archivingAt: null,
  diffStat: { additions: 12, deletions: 3 },
  scripts: [],
};

const agent: Agent = {
  serverId: "host-1",
  id: "agent-1",
  provider: "codex",
  status: "running",
  activeTurn: null,
  createdAt: new Date("2026-08-16T10:01:00.000Z"),
  updatedAt: new Date("2026-08-16T10:02:00.000Z"),
  lastUserMessageAt: null,
  lastActivityAt: new Date("2026-08-16T10:03:00.000Z"),
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  },
  currentModeId: "code",
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  title: "Implement plugin panels",
  cwd: "/repo/paseo/review",
  workspaceId: "workspace-1",
  model: "gpt-5.6",
  thinkingOptionId: "high",
  requiresAttention: true,
  attentionReason: "permission",
  parentAgentId: null,
  labels: { phase: "implementation" },
};

describe("plugin context snapshots", () => {
  it("commits a deeply immutable normalized workspace snapshot synchronously", () => {
    const snapshot = createPluginWorkspaceSnapshot(workspace);
    expect(createPluginWorkspaceSnapshot(workspace)).toBe(snapshot);

    expect(snapshot).toEqual({
      id: "workspace-1",
      projectId: "project-1",
      projectDisplayName: "Paseo",
      projectRootPath: "/repo/paseo",
      directory: "/repo/paseo/review",
      projectKind: "git",
      kind: "worktree",
      name: "Review",
      title: "Plugin review",
      status: "running",
      statusEnteredAt: "2026-08-16T10:00:00.000Z",
      archivingAt: null,
      diffStat: { additions: 12, deletions: 3 },
    });
    expect(snapshot.diffStat).not.toBe(workspace.diffStat);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.diffStat)).toBe(true);
    expect(Reflect.set(snapshot, "name", "Hostile rename")).toBe(false);
    expect(Reflect.set(snapshot.diffStat!, "additions", 999)).toBe(false);
    expect(snapshot.name).toBe("Review");
    expect(snapshot.diffStat).toEqual({ additions: 12, deletions: 3 });
    expect(workspace.name).toBe("Review");
    expect(workspace.diffStat).toEqual({ additions: 12, deletions: 3 });
  });

  it("commits a deeply immutable matching agent snapshot without exposing store records", () => {
    const snapshot = createPluginAgentSnapshot(agent, workspace.id);
    expect(createPluginAgentSnapshot(agent, workspace.id)).toBe(snapshot);

    expect(snapshot).toEqual({
      id: "agent-1",
      workspaceId: "workspace-1",
      provider: "codex",
      status: "running",
      createdAt: "2026-08-16T10:01:00.000Z",
      updatedAt: "2026-08-16T10:02:00.000Z",
      lastActivityAt: "2026-08-16T10:03:00.000Z",
      title: "Implement plugin panels",
      cwd: "/repo/paseo/review",
      model: "gpt-5.6",
      currentModeId: "code",
      thinkingOptionId: "high",
      requiresAttention: true,
      attentionReason: "permission",
      parentAgentId: null,
      labels: { phase: "implementation" },
    });
    expect(snapshot.labels).not.toBe(agent.labels);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.labels)).toBe(true);
    expect(Reflect.set(snapshot, "title", "Hostile rename")).toBe(false);
    expect(Reflect.set(snapshot.labels, "phase", "hostile")).toBe(false);
    expect(snapshot.title).toBe("Implement plugin panels");
    expect(snapshot.labels).toEqual({ phase: "implementation" });
    expect(agent.title).toBe("Implement plugin panels");
    expect(agent.labels).toEqual({ phase: "implementation" });
  });
});
