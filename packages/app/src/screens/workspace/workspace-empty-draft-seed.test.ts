import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import { deriveWorkspaceAgentVisibility } from "@/workspace-tabs/agent-visibility";
import {
  decideEmptyWorkspaceRecovery,
  isEmptyWorkspaceLayoutReady,
  selectRediscoverableHiddenAgentIds,
  shouldSeedEmptyWorkspaceDraft,
} from "./workspace-empty-draft-seed";

function makeAgent(input: {
  id: string;
  cwd: string;
  workspaceId?: string;
  parentAgentId?: string | null;
}): Agent {
  const createdAt = new Date("2026-03-04T00:00:00.000Z");
  return {
    serverId: "srv",
    id: input.id,
    provider: "codex",
    status: "idle",
    createdAt,
    updatedAt: createdAt,
    lastUserMessageAt: null,
    lastActivityAt: createdAt,
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
    pendingPermissions: [],
    persistence: null,
    runtimeInfo: {
      provider: "codex",
      sessionId: null,
    },
    title: null,
    cwd: input.cwd,
    workspaceId: input.workspaceId,
    model: null,
    thinkingOptionId: null,
    parentAgentId: input.parentAgentId ?? null,
    labels: {},
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
  };
}

const readyEmptyLayout = {
  isRouteFocused: true,
  hasPersistenceKey: true,
  hasWorkspaceDirectory: true,
  hasHydratedWorkspaceLayoutStore: true,
  hasHydratedAgents: true,
  hasLoadedTerminals: true,
  terminalCount: 0,
  tabCount: 0,
};

const readyEmptyWorkspace = {
  ...readyEmptyLayout,
  activeAgentCount: 0,
};

describe("shouldSeedEmptyWorkspaceDraft", () => {
  it("waits for refresh-time hydration before seeding a draft", () => {
    expect(
      shouldSeedEmptyWorkspaceDraft({
        ...readyEmptyWorkspace,
        hasHydratedWorkspaceLayoutStore: false,
      }),
    ).toBe(false);
    expect(
      shouldSeedEmptyWorkspaceDraft({
        ...readyEmptyWorkspace,
        hasHydratedAgents: false,
      }),
    ).toBe(false);
    expect(
      shouldSeedEmptyWorkspaceDraft({
        ...readyEmptyWorkspace,
        hasLoadedTerminals: false,
      }),
    ).toBe(false);
  });

  it("does not seed when existing workspace content is known", () => {
    expect(
      shouldSeedEmptyWorkspaceDraft({
        ...readyEmptyWorkspace,
        activeAgentCount: 1,
      }),
    ).toBe(false);
    expect(
      shouldSeedEmptyWorkspaceDraft({
        ...readyEmptyWorkspace,
        terminalCount: 1,
      }),
    ).toBe(false);
    expect(
      shouldSeedEmptyWorkspaceDraft({
        ...readyEmptyWorkspace,
        tabCount: 1,
      }),
    ).toBe(false);
  });

  it("seeds once an empty focused workspace is fully known", () => {
    expect(shouldSeedEmptyWorkspaceDraft(readyEmptyWorkspace)).toBe(true);
  });
});

describe("isEmptyWorkspaceLayoutReady", () => {
  it("is ready with active agents when tabs and terminals are empty", () => {
    expect(isEmptyWorkspaceLayoutReady(readyEmptyLayout)).toBe(true);
  });

  it("is not ready while tabs remain", () => {
    expect(
      isEmptyWorkspaceLayoutReady({
        ...readyEmptyLayout,
        tabCount: 1,
      }),
    ).toBe(false);
  });
});

describe("selectRediscoverableHiddenAgentIds", () => {
  it("returns the intersection of hidden, auto-open, and active agent ids", () => {
    expect(
      selectRediscoverableHiddenAgentIds({
        hiddenAgentIds: new Set(["child-a", "child-b", "hidden-only"]),
        autoOpenAgentIds: new Set(["child-b", "child-a", "auto-only"]),
        activeAgentIds: new Set(["child-a", "active-only", "child-b"]),
      }),
    ).toEqual(["child-a", "child-b"]);
  });

  it("returns an empty list when any set misses the candidate", () => {
    expect(
      selectRediscoverableHiddenAgentIds({
        hiddenAgentIds: new Set(["child-agent"]),
        autoOpenAgentIds: new Set(["child-agent"]),
        activeAgentIds: new Set(),
      }),
    ).toEqual([]);
  });
});

describe("decideEmptyWorkspaceRecovery", () => {
  it("reopens a hidden cross-workspace child before seeding a draft", () => {
    expect(
      decideEmptyWorkspaceRecovery({
        layoutReady: true,
        rediscoverableHiddenAgentIds: ["child-agent"],
        activeAgentCount: 1,
      }),
    ).toEqual({ kind: "reopen-hidden-agents", agentIds: ["child-agent"] });
  });

  it("seeds a draft only when nothing rediscoverable remains and no agents are active", () => {
    expect(
      decideEmptyWorkspaceRecovery({
        layoutReady: true,
        rediscoverableHiddenAgentIds: [],
        activeAgentCount: 0,
      }),
    ).toEqual({ kind: "seed-draft" });
  });

  it("does not seed a draft over active same-workspace agents that are not auto-open", () => {
    expect(
      decideEmptyWorkspaceRecovery({
        layoutReady: true,
        rediscoverableHiddenAgentIds: [],
        activeAgentCount: 1,
      }),
    ).toEqual({ kind: "noop" });
  });

  it("is a noop when the empty layout gate is closed", () => {
    expect(
      decideEmptyWorkspaceRecovery({
        layoutReady: false,
        rediscoverableHiddenAgentIds: ["child-agent"],
        activeAgentCount: 1,
      }),
    ).toEqual({ kind: "noop" });
  });

  it("close → hide → empty-seed reopens a cross-workspace child", () => {
    const parent = makeAgent({
      id: "parent-agent",
      cwd: "/repo",
      workspaceId: "ws-parent",
    });
    const child = makeAgent({
      id: "child-agent",
      cwd: "/repo/worktree",
      workspaceId: "ws-child",
      parentAgentId: parent.id,
    });
    const visibility = deriveWorkspaceAgentVisibility({
      sessionAgents: new Map([
        [parent.id, parent],
        [child.id, child],
      ]),
      workspaceId: "ws-child",
    });

    // Closing the child tab hides it without archiving (layout-only).
    const hiddenAgentIds = new Set(["child-agent"]);
    expect(child.archivedAt).toBeNull();
    expect(visibility.autoOpenAgentIds).toEqual(new Set(["child-agent"]));
    expect(visibility.activeAgentIds).toEqual(new Set(["child-agent"]));

    const rediscoverableHiddenAgentIds = selectRediscoverableHiddenAgentIds({
      hiddenAgentIds,
      autoOpenAgentIds: visibility.autoOpenAgentIds,
      activeAgentIds: visibility.activeAgentIds,
    });
    expect(
      decideEmptyWorkspaceRecovery({
        layoutReady: true,
        rediscoverableHiddenAgentIds,
        activeAgentCount: visibility.activeAgentIds.size,
      }),
    ).toEqual({ kind: "reopen-hidden-agents", agentIds: ["child-agent"] });
  });
});
