import { describe, expect, it, vi } from "vitest";
import { openProjectDirectly } from "@/hooks/open-project";
import type { WorkspaceDescriptor } from "@/stores/session-store";

const SERVER_ID = "server-1";
const PROJECT_PATH = "/repo/project";

function buildWorkspacePayload() {
  return {
    id: "1",
    projectId: "1",
    projectDisplayName: "project",
    projectRootPath: PROJECT_PATH,
    workspaceDirectory: PROJECT_PATH,
    projectKind: "git" as const,
    workspaceKind: "checkout" as const,
    name: "project",
    archivingAt: null,
    status: "done" as const,
    statusEnteredAt: null,
    activityAt: null,
    diffStat: null,
    scripts: [],
  };
}

interface RecordedMerge {
  serverId: string;
  workspaces: WorkspaceDescriptor[];
}

interface RecordedHydrated {
  serverId: string;
  hydrated: boolean;
}

interface RecordedOpenDraftTab {
  workspaceKey: string;
}

interface RecordedNavigate {
  serverId: string;
  workspaceId: string;
}

function createFakeSession() {
  const merges: RecordedMerge[] = [];
  const hydrated: RecordedHydrated[] = [];
  return {
    merges,
    hydrated,
    mergeWorkspaces: (serverId: string, workspaces: Iterable<WorkspaceDescriptor>) => {
      merges.push({ serverId, workspaces: Array.from(workspaces) });
    },
    setHasHydratedWorkspaces: (serverId: string, value: boolean) => {
      hydrated.push({ serverId, hydrated: value });
    },
  };
}

function createFakeWorkspaceLayout() {
  const openedTabs: RecordedOpenDraftTab[] = [];
  return {
    openedTabs,
    openDraftTab: (workspaceKey: string) => {
      openedTabs.push({ workspaceKey });
      return "tab-1";
    },
  };
}

function createFakeNavigator() {
  const navigations: RecordedNavigate[] = [];
  return {
    navigations,
    navigateToWorkspace: (serverId: string, workspaceId: string) => {
      navigations.push({ serverId, workspaceId });
    },
  };
}

describe("openProjectDirectly", () => {
  it("opens the workspace, marks workspaces hydrated, and seeds a draft tab", async () => {
    const session = createFakeSession();
    const layout = createFakeWorkspaceLayout();
    const navigator = createFakeNavigator();
    const workspacePayload = buildWorkspacePayload();

    const result = await openProjectDirectly({
      serverId: SERVER_ID,
      projectPath: PROJECT_PATH,
      isConnected: true,
      client: {
        openProject: vi.fn(async () => ({
          requestId: "request-1",
          error: null,
          workspace: workspacePayload,
        })),
      },
      mergeWorkspaces: session.mergeWorkspaces,
      setHasHydratedWorkspaces: session.setHasHydratedWorkspaces,
      openDraftTab: layout.openDraftTab,
      navigateToWorkspace: navigator.navigateToWorkspace,
    });

    expect(result).toBe(true);
    expect(session.merges).toHaveLength(1);
    expect(session.merges[0]?.serverId).toBe(SERVER_ID);
    expect(session.merges[0]?.workspaces[0]).toMatchObject({
      id: "1",
      projectId: "1",
      projectRootPath: PROJECT_PATH,
      workspaceDirectory: PROJECT_PATH,
    });
    expect(session.hydrated).toEqual([{ serverId: SERVER_ID, hydrated: true }]);
    expect(layout.openedTabs).toEqual([{ workspaceKey: `${SERVER_ID}:1` }]);
    expect(navigator.navigations).toEqual([{ serverId: SERVER_ID, workspaceId: "1" }]);
  });

  it("does not navigate or seed tabs when openProject fails", async () => {
    const session = createFakeSession();
    const layout = createFakeWorkspaceLayout();
    const navigator = createFakeNavigator();

    const result = await openProjectDirectly({
      serverId: SERVER_ID,
      projectPath: PROJECT_PATH,
      isConnected: true,
      client: {
        openProject: vi.fn(async () => ({
          requestId: "request-2",
          error: "Failed to open project",
          workspace: null,
        })),
      },
      mergeWorkspaces: session.mergeWorkspaces,
      setHasHydratedWorkspaces: session.setHasHydratedWorkspaces,
      openDraftTab: layout.openDraftTab,
      navigateToWorkspace: navigator.navigateToWorkspace,
    });

    expect(result).toBe(false);
    expect(session.merges).toEqual([]);
    expect(session.hydrated).toEqual([]);
    expect(layout.openedTabs).toEqual([]);
    expect(navigator.navigations).toEqual([]);
  });
});
