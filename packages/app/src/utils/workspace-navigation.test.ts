import { beforeEach, describe, expect, it, vi } from "vitest";

const { platformState, routerMock } = vi.hoisted(() => ({
  platformState: {
    isNative: false,
    isWeb: true,
  },
  routerMock: {
    back: vi.fn(),
    canGoBack: vi.fn(() => false),
    navigate: vi.fn(),
    replace: vi.fn(),
  },
}));

vi.mock("expo-router", () => ({
  router: routerMock,
}));

vi.mock("@/constants/platform", () => ({
  get isNative() {
    return platformState.isNative;
  },
  get isWeb() {
    return platformState.isWeb;
  },
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

import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  getNavigationActiveWorkspaceSelection,
  syncNavigationActiveWorkspace,
} from "@/stores/navigation-active-workspace-store";
import { navigateToPreparedWorkspaceTab, prepareWorkspaceTab } from "@/utils/workspace-navigation";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "/repo/worktree";
const AGENT_ID = "agent-1";

describe("prepareWorkspaceTab", () => {
  beforeEach(() => {
    vi.useRealTimers();
    platformState.isNative = false;
    platformState.isWeb = true;
    routerMock.back.mockReset();
    routerMock.canGoBack.mockReset();
    routerMock.canGoBack.mockReturnValue(false);
    routerMock.navigate.mockReset();
    routerMock.replace.mockReset();
    syncNavigationActiveWorkspace({ current: null });
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: {},
      splitSizesByWorkspace: {},
      pinnedAgentIdsByWorkspace: {},
      hiddenAgentIdsByWorkspace: {},
    });
  });

  it("opens and focuses an agent tab", () => {
    const route = prepareWorkspaceTab({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "agent", agentId: AGENT_ID },
    });

    expect(route).toBe("/h/server-1/workspace/b64_L3JlcG8vd29ya3RyZWU");
    const key = "server-1:/repo/worktree";
    expect(useWorkspaceLayoutStore.getState().getWorkspaceTabs(key)).toHaveLength(1);
  });

  it("pops back to the retained workspace shell for native replace navigation", () => {
    vi.useFakeTimers();
    platformState.isNative = true;
    platformState.isWeb = false;
    routerMock.canGoBack.mockReturnValue(true);

    syncNavigationActiveWorkspace({
      current: {
        getCurrentRoute: () => ({
          path: "/h/server-1/workspace/source-workspace",
        }),
      },
    });

    const route = navigateToPreparedWorkspaceTab({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "agent", agentId: AGENT_ID },
      navigationMethod: "replace",
    });

    expect(route).toBe("/h/server-1/workspace/b64_L3JlcG8vd29ya3RyZWU");
    expect(routerMock.back).toHaveBeenCalledOnce();
    expect(routerMock.replace).not.toHaveBeenCalled();

    vi.runAllTimers();

    expect(getNavigationActiveWorkspaceSelection()).toEqual({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
    });
  });
});
