import { beforeEach, describe, expect, it, vi } from "vitest";

const { routerMock } = vi.hoisted(() => ({
  routerMock: {
    dismissTo: vi.fn(),
    navigate: vi.fn(),
    replace: vi.fn(),
  },
}));

vi.mock("expo-router", () => ({
  router: routerMock,
  useLocalSearchParams: () => ({}),
  usePathname: () => "/",
}));

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

import type { DaemonClient } from "@server/client/daemon-client";
import { useSessionStore, type Agent, type WorkspaceDescriptor } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "workspace-1";
const AGENT_ID = "agent-1";

function createWorkspace(): WorkspaceDescriptor {
  return {
    id: WORKSPACE_ID,
    projectId: "project-1",
    projectDisplayName: "Project",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo/worktree",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "worktree",
    status: "done",
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

function createAgent(input: Partial<Agent> = {}): Agent {
  return {
    serverId: SERVER_ID,
    id: AGENT_ID,
    provider: "codex",
    status: "closed",
    createdAt: new Date("2026-05-09T00:00:00.000Z"),
    updatedAt: new Date("2026-05-09T00:00:00.000Z"),
    lastUserMessageAt: null,
    lastActivityAt: new Date("2026-05-09T00:00:00.000Z"),
    capabilities: {
      supportsStreaming: false,
      supportsSessionPersistence: false,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: "Archived agent",
    cwd: "/repo/worktree",
    model: null,
    thinkingOptionId: null,
    archivedAt: new Date("2026-05-09T00:00:00.000Z"),
    parentAgentId: null,
    labels: {},
    ...input,
  };
}

describe("navigateToAgent", () => {
  beforeEach(() => {
    routerMock.dismissTo.mockReset();
    routerMock.navigate.mockReset();
    routerMock.replace.mockReset();
    useSessionStore.getState().clearSession(SERVER_ID);
    useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
    useSessionStore
      .getState()
      .setWorkspaces(SERVER_ID, new Map([[WORKSPACE_ID, createWorkspace()]]));
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: {},
      splitSizesByWorkspace: {},
      pinnedAgentIdsByWorkspace: {},
      hiddenAgentIdsByWorkspace: {},
    });
  });

  it("opens archived agent details through the resolved workspace", () => {
    useSessionStore.getState().setAgentDetails(SERVER_ID, new Map([[AGENT_ID, createAgent()]]));

    const route = navigateToAgent({ serverId: SERVER_ID, agentId: AGENT_ID, pin: true });

    expect(route).toBe("/h/server-1/workspace/workspace-1");
    expect(routerMock.navigate).not.toHaveBeenCalled();
    expect(routerMock.dismissTo).toHaveBeenCalledWith("/h/server-1/workspace/workspace-1");
    const key = `${SERVER_ID}:${WORKSPACE_ID}`;
    expect(useWorkspaceLayoutStore.getState().getWorkspaceTabs(key)).toEqual([
      expect.objectContaining({ target: { kind: "agent", agentId: AGENT_ID } }),
    ]);
    expect(useWorkspaceLayoutStore.getState().pinnedAgentIdsByWorkspace[key]).toEqual(
      new Set([AGENT_ID]),
    );
  });

  it("falls back to the host agent route when the workspace is unknown", () => {
    const route = navigateToAgent({ serverId: SERVER_ID, agentId: "missing-agent" });

    expect(route).toBe("/h/server-1/agent/missing-agent");
    expect(routerMock.navigate).toHaveBeenCalledWith("/h/server-1/agent/missing-agent");
    expect(routerMock.dismissTo).not.toHaveBeenCalled();
  });
});
