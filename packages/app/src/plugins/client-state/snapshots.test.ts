import { i18n } from "@/i18n/i18next";
import { fr } from "@/i18n/resources/fr";
import { describe, expect, it } from "vitest";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { normalizeAgentSnapshot, projectAgentSnapshot } from "@/utils/agent-snapshots";
import {
  createPluginAgentSnapshot,
  createPluginWorkspaceSnapshot,
  createPluginProjectSnapshot,
} from "./snapshots";

import { workspace, agent } from "./fixtures";
describe("plugin context snapshots", () => {
  it("commits a deeply immutable normalized workspace snapshot synchronously", () => {
    const snapshot = createPluginWorkspaceSnapshot(workspace, "host-1");
    expect(createPluginWorkspaceSnapshot(workspace, "host-1")).toBe(snapshot);

    expect(snapshot).toMatchObject({
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

    expect(snapshot).toMatchObject({
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
      metadata: { "linear.issue": { id: "ENG-1" } },
    });
    expect(snapshot.labels).not.toBe(agent.labels);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.labels)).toBe(true);
    expect(Reflect.set(snapshot, "title", "Hostile rename")).toBe(false);
    expect(Reflect.set(snapshot.labels, "phase", "hostile")).toBe(false);
    const issue = snapshot.metadata["linear.issue"] as { id: string };
    expect(Reflect.set(issue, "id", "hostile")).toBe(false);
    expect(agent.metadata?.["linear.issue"]).toEqual({ id: "ENG-1" });
    expect(snapshot.title).toBe("Implement plugin panels");
    expect(snapshot.labels).toEqual({ phase: "implementation" });
    expect(agent.title).toBe("Implement plugin panels");
    expect(agent.labels).toEqual({ phase: "implementation" });
  });
});

describe("sidebar entity snapshots", () => {
  it("interns cross-host references and preserves identity across unrelated reads", () => {
    const first = createPluginWorkspaceSnapshot(workspace, "host-1");
    const second = createPluginWorkspaceSnapshot(workspace, "host-2");
    expect(first.ref).not.toBe(second.ref);
    expect(first.ref.hostId).toBe("host-1");
    expect(first.project.id).toBe(workspace.projectId);
    expect(Object.isFrozen(first.labels)).toBe(true);
    expect(createPluginWorkspaceSnapshot(workspace, "host-1")).toBe(first);
    expect(createPluginAgentSnapshot(agent, workspace.id).workspace).toBe(first.ref);
  });

  it("invalidates a done workspace when its effective root-agent status changes", () => {
    const idle: WorkspaceDescriptor = { ...workspace, status: "done" };
    const before = createPluginWorkspaceSnapshot(idle, "host-1");
    const activity = new Map([
      [idle.id, { agentId: agent.id, status: "needs_input" as const, enteredAt: null }],
    ]);
    const after = createPluginWorkspaceSnapshot(idle, "host-1", {
      workspaceAgentActivity: activity,
    });
    expect(before.indicator).toBe("done");
    expect(after.status).toBe("done");
    expect(after.indicator).toBe("needs_input");
    expect(after.indicatorLabel).toBe("Needs input");
    expect(after.ref).toBe(before.ref);
    expect(
      createPluginWorkspaceSnapshot(idle, "host-1", { workspaceAgentActivity: activity }),
    ).toBe(after);
  });

  it("carries the background work count the host publishes for the agent", () => {
    // Round-trip through the wire payload, the way the app receives each agent update.
    const published = (backgroundWork: Agent["backgroundWork"]) =>
      createPluginAgentSnapshot(
        normalizeAgentSnapshot({ ...projectAgentSnapshot(agent), backgroundWork }, agent.serverId),
        workspace.id,
      ).backgroundWork;
    expect(published(undefined)).toEqual({ count: 0 });
    expect(published({ count: 2 })).toEqual({ count: 2 });
    expect(published({ count: 0 })).toEqual({ count: 0 });
    expect(Object.isFrozen(published({ count: 1 }))).toBe(true);
  });

  it("marks a background agent", () => {
    expect(createPluginAgentSnapshot(agent, workspace.id).background).toBe(false);
    expect(createPluginAgentSnapshot({ ...agent, background: true }, workspace.id).background).toBe(
      true,
    );
  });

  it("reads projects without requiring a workspace", () => {
    const project = {
      projectId: "empty",
      projectDisplayName: "Empty",
      projectCustomName: null,
      projectRootPath: "/empty",
      projectKind: "git" as const,
    };
    const snapshot = createPluginProjectSnapshot(project, "host-1");
    expect(createPluginProjectSnapshot(project, "host-1")).toBe(snapshot);
    expect(snapshot.displayName).toBe("Empty");
    expect(snapshot.ref.id).toBe("empty");
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});

it("uses the app status labels and invalidates a snapshot on language change", async () => {
  i18n.addResourceBundle("fr", "translation", fr);
  const previousLanguage = i18n.language;
  try {
    await i18n.changeLanguage("en");
    const english = createPluginWorkspaceSnapshot(workspace, "host-1");
    expect(english.indicatorLabel).toBe("Working");
    await i18n.changeLanguage("fr");
    const french = createPluginWorkspaceSnapshot(workspace, "host-1");
    expect(french).not.toBe(english);
    expect(french.ref).toBe(english.ref);
    expect(french.indicatorLabel).toBe("En cours");
    expect(createPluginWorkspaceSnapshot(workspace, "host-1")).toBe(french);
  } finally {
    await i18n.changeLanguage(previousLanguage);
  }
});

it("preserves the host-qualified parent of a remotely delegated agent", () => {
  const child = {
    ...agent,
    serverId: "host-2",
    parentAgentId: null,
    labels: { "paseo.parent-server-id": "host-1", "paseo.parent-agent-id": "parent" },
  };
  expect(createPluginAgentSnapshot(child, workspace.id).parentAgent).toMatchObject({
    hostId: "host-1",
    id: "parent",
    kind: "agent",
  });
});
