import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { replaceRoute } = vi.hoisted(() => ({
  replaceRoute: vi.fn(),
}));

vi.mock("expo-router", () => ({
  router: {
    replace: replaceRoute,
  },
}));

import { openProjectDirectly } from "@/hooks/use-open-project";
import { useSessionStore } from "@/stores/session-store";
import {
  buildWorkspaceTabPersistenceKey,
  collectAllTabs,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { generateDraftId } from "@/stores/draft-keys";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "/repo/project";

function createOpenDraftTab() {
  return (workspaceKey: string) =>
    useWorkspaceLayoutStore.getState().openTabFocused(workspaceKey, {
      kind: "draft",
      draftId: generateDraftId(),
    });
}

describe("openProjectDirectly", () => {
  beforeEach(() => {
    replaceRoute.mockReset();
    useSessionStore.setState({
      sessions: {},
    });
    useSessionStore.getState().initializeSession(SERVER_ID, {} as never);
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: {},
      splitSizesByWorkspace: {},
      pinnedAgentIdsByWorkspace: {},
    });
    vi.restoreAllMocks();
  });

  it("opens the workspace directly, marks workspaces hydrated, and seeds a draft tab", async () => {
    const result = await openProjectDirectly({
      serverId: SERVER_ID,
      projectPath: WORKSPACE_ID,
      isConnected: true,
      client: {
        openProject: vi.fn(async () => ({
          requestId: "request-1",
          error: null,
          workspace: {
            id: "1",
            projectId: "1",
            projectDisplayName: "project",
            projectRootPath: WORKSPACE_ID,
            workspaceDirectory: WORKSPACE_ID,
            projectKind: "git" as const,
            workspaceKind: "checkout" as const,
            name: "project",
            archivingAt: null,
            status: "done" as const,
            activityAt: null,
            diffStat: null,
            scripts: [],
          },
        })),
      },
      mergeWorkspaces: useSessionStore.getState().mergeWorkspaces,
      setHasHydratedWorkspaces: useSessionStore.getState().setHasHydratedWorkspaces,
      openDraftTab: createOpenDraftTab(),
      replaceRoute,
    });

    expect(result).toBe(true);
    expect(useSessionStore.getState().sessions[SERVER_ID]?.hasHydratedWorkspaces).toBe(true);
    expect(
      Array.from(useSessionStore.getState().sessions[SERVER_ID]?.workspaces.values() ?? []),
    ).toEqual([
      expect.objectContaining({
        id: "1",
        projectId: "1",
        projectRootPath: WORKSPACE_ID,
        workspaceDirectory: WORKSPACE_ID,
      }),
    ]);

    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: SERVER_ID,
      workspaceId: "1",
    });
    expect(workspaceKey).toBeTruthy();
    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey as string];
    expect(layout.root.kind).toBe("pane");
    const tabs = collectAllTabs(layout.root);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.target.kind).toBe("draft");
    expect(replaceRoute).toHaveBeenCalledWith("/h/server-1/workspace/1");
  });

  it("does not navigate or seed tabs when openProject fails", async () => {
    const result = await openProjectDirectly({
      serverId: SERVER_ID,
      projectPath: WORKSPACE_ID,
      isConnected: true,
      client: {
        openProject: vi.fn(async () => ({
          requestId: "request-2",
          error: "Failed to open project",
          workspace: null,
        })),
      },
      mergeWorkspaces: useSessionStore.getState().mergeWorkspaces,
      setHasHydratedWorkspaces: useSessionStore.getState().setHasHydratedWorkspaces,
      openDraftTab: createOpenDraftTab(),
      replaceRoute,
    });

    expect(result).toBe(false);
    expect(useSessionStore.getState().sessions[SERVER_ID]?.hasHydratedWorkspaces).toBe(false);
    expect(useSessionStore.getState().sessions[SERVER_ID]?.workspaces.size).toBe(0);
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace).toEqual({});
    expect(replaceRoute).not.toHaveBeenCalled();
  });
});
