import { describe, expect, it } from "vitest";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { createPluginAgentSnapshot, createPluginWorkspaceSnapshot } from "./snapshots";

const workspace: WorkspaceDescriptor = {
  createdAt: null,
  lastUserMessageAt: null,
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
  turn: { phase: "idle", cancellationRequestId: null },
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

  it("copies and freezes workspace activity members without freezing store records", () => {
    const activity = {
      id: "tasks/builds",
      pluginId: "tasks",
      activityId: "builds",
      workspaceId: workspace.id,
      kind: "background-task",
      label: "Builds",
      status: "running" as const,
      count: 1,
      changedAt: "2026-08-16T10:00:00.000Z",
      items: [{ id: "build-1", label: "Build" }],
    };
    const source = { ...workspace, activities: [activity], primaryActivityId: activity.id };
    const snapshot = createPluginWorkspaceSnapshot(source);
    expect(createPluginWorkspaceSnapshot(source)).toBe(snapshot);
    const projected = snapshot.activities![0]!;
    expect(snapshot.primaryActivityId).toBe(activity.id);
    expect(projected).toEqual(activity);
    expect(snapshot.activities).not.toBe(source.activities);
    expect(projected).not.toBe(activity);
    expect(projected.items).not.toBe(activity.items);
    expect(projected.items![0]).not.toBe(activity.items[0]);
    expect(Object.isFrozen(snapshot.activities)).toBe(true);
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.items)).toBe(true);
    expect(Object.isFrozen(projected.items![0])).toBe(true);
    expect(Reflect.set(projected.items![0]!, "label", "Hostile rename")).toBe(false);
    expect(Reflect.set(projected.items!, 0, { id: "other", label: "Other" })).toBe(false);
    expect(activity.items[0]?.label).toBe("Build");
    expect(Object.isFrozen(activity.items)).toBe(false);
    expect(Object.isFrozen(activity.items[0])).toBe(false);

    activity.items[0]!.label = "Store update";
    expect(projected.items![0]?.label).toBe("Build");
    expect(createPluginWorkspaceSnapshot({ ...source }).activities![0]!.items![0]?.label).toBe(
      "Store update",
    );
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
