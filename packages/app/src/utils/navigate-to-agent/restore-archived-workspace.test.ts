import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { HostRuntimeSnapshot } from "@/runtime/host-runtime";

const refreshAgent = vi.fn<(agentId: string) => Promise<unknown>>();
let connected = true;

vi.mock("expo-router", () => ({
  router: { navigate: vi.fn() },
}));

vi.mock("@/utils/workspace-navigation", () => ({
  navigateToPreparedWorkspaceTab: vi.fn(() => ""),
}));

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getSnapshot: () => ({ client: { refreshAgent } }) as unknown as HostRuntimeSnapshot,
  }),
  isHostRuntimeConnected: () => connected,
}));

import { useSessionStore, type Agent } from "@/stores/session-store";
import { navigateToAgent } from "./index";

const SERVER_ID = "server-1";
const AGENT_ID = "agent-1";
const WORKSPACE_ID = "workspace-1";

function agent(archivedAt: Date | null): Agent {
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  return {
    serverId: SERVER_ID,
    id: AGENT_ID,
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
    title: null,
    cwd: "/repo",
    workspaceId: WORKSPACE_ID,
    model: null,
    archivedAt,
    parentAgentId: null,
    labels: {},
  };
}

function status(): "restoring" | "failed" | "needs-host-upgrade" | null {
  return (
    useSessionStore.getState().sessions[SERVER_ID]?.restoringWorkspaces.get(WORKSPACE_ID) ?? null
  );
}

function seedArchivedAgent(options?: { worktreeRestore?: boolean }): void {
  const store = useSessionStore.getState();
  store.initializeSession(SERVER_ID, null as unknown as DaemonClient);
  store.updateSessionServerInfo(SERVER_ID, {
    serverId: SERVER_ID,
    hostname: "host",
    version: "0.1.98",
    features: { worktreeRestore: options?.worktreeRestore ?? true },
  } as unknown as Parameters<typeof store.updateSessionServerInfo>[1]);
  store.setAgents(SERVER_ID, (prev) => {
    const next = new Map(prev);
    next.set(AGENT_ID, agent(new Date("2026-01-02T00:00:00.000Z")));
    return next;
  });
}

describe("restoreArchivedWorkspace via navigateToAgent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refreshAgent.mockReset();
    connected = true;
    seedArchivedAgent();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    useSessionStore.getState().clearSession(SERVER_ID);
  });

  function trigger(): void {
    navigateToAgent({ serverId: SERVER_ID, agentId: AGENT_ID });
  }

  it("calls refreshAgent once and marks the workspace restoring", () => {
    refreshAgent.mockImplementation(() => new Promise(() => {}));

    trigger();

    expect(refreshAgent).toHaveBeenCalledTimes(1);
    expect(refreshAgent).toHaveBeenCalledWith(AGENT_ID);
    expect(status()).toBe("restoring");
  });

  it("does not re-fire while a restore for the same workspace is in flight", () => {
    refreshAgent.mockImplementation(() => new Promise(() => {}));

    trigger();
    trigger();
    trigger();

    expect(refreshAgent).toHaveBeenCalledTimes(1);
  });

  it("does not fire for a non-archived agent", () => {
    const store = useSessionStore.getState();
    store.setAgents(SERVER_ID, (prev) => {
      const next = new Map(prev);
      next.set(AGENT_ID, agent(null));
      return next;
    });
    refreshAgent.mockImplementation(() => new Promise(() => {}));

    trigger();

    expect(refreshAgent).not.toHaveBeenCalled();
    expect(status()).toBeNull();
  });

  it("does not fire while disconnected", () => {
    connected = false;
    refreshAgent.mockImplementation(() => new Promise(() => {}));

    trigger();

    expect(refreshAgent).not.toHaveBeenCalled();
    expect(status()).toBeNull();
  });

  it("flips to failed when refreshAgent rejects", async () => {
    refreshAgent.mockImplementation(() => Promise.reject(new Error("dir gone")));

    trigger();
    expect(status()).toBe("restoring");

    await vi.runAllTicks();
    await Promise.resolve();

    expect(status()).toBe("failed");
  });

  it("flips to failed via the timeout when refreshAgent resolves without a workspace update", async () => {
    refreshAgent.mockImplementation(() => Promise.resolve({}));

    trigger();
    await Promise.resolve();
    expect(status()).toBe("restoring");

    await vi.advanceTimersByTimeAsync(30000);
    expect(status()).toBe("failed");
  });

  it("marks the workspace needs-host-upgrade without refreshing when the daemon lacks worktreeRestore", () => {
    useSessionStore.getState().clearSession(SERVER_ID);
    seedArchivedAgent({ worktreeRestore: false });
    refreshAgent.mockImplementation(() => new Promise(() => {}));

    trigger();

    expect(refreshAgent).not.toHaveBeenCalled();
    expect(status()).toBe("needs-host-upgrade");
  });

  it("is a no-op when the workspace descriptor is already present", () => {
    refreshAgent.mockImplementation(() => new Promise(() => {}));
    useSessionStore.getState().mergeWorkspaces(SERVER_ID, [
      {
        id: WORKSPACE_ID,
        projectId: "project-1",
        projectDisplayName: "Project 1",
        projectRootPath: "/repo",
        workspaceDirectory: "/repo",
        projectKind: "git",
        workspaceKind: "local_checkout",
        name: "main",
        status: "done",
        statusEnteredAt: null,
        archivingAt: null,
        diffStat: null,
        scripts: [],
      },
    ]);

    trigger();

    expect(refreshAgent).not.toHaveBeenCalled();
  });
});
