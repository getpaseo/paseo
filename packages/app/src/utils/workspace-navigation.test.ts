import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-router", () => ({
  router: {
    navigate: vi.fn(),
    replace: vi.fn(),
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
import { prepareWorkspaceTab } from "@/utils/workspace-navigation";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "/repo/worktree";
const AGENT_ID = "agent-1";

describe("prepareWorkspaceTab", () => {
  beforeEach(() => {
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
});
