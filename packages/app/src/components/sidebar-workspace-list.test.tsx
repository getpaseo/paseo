/**
 * @vitest-environment jsdom
 */
import { act, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceScriptPayload } from "@getpaseo/protocol/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React from "react";
import type { ReactElement } from "react";

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

const pathnameState = vi.hoisted(() => ({
  value: "/",
}));

vi.mock("expo-router", () => ({
  router: {
    dismissTo: vi.fn(),
    navigate: vi.fn(),
    replace: vi.fn(),
  },
  useLocalSearchParams: () => ({}),
  usePathname: () => pathnameState.value,
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: <T,>(factory: T) =>
      typeof factory === "function"
        ? factory({
            borderRadius: { full: 999, lg: 12, md: 8, sm: 4 },
            borderWidth: { 1: 1 },
            colors: {
              border: "#d0d0d0",
              foreground: "#111111",
              foregroundMuted: "#666666",
              palette: {
                amber: { 500: "#f59e0b", 700: "#b45309" },
                blue: { 500: "#3b82f6" },
                green: { 500: "#22c55e" },
                purple: { 500: "#a855f7" },
                red: { 500: "#ef4444" },
              },
              popoverForeground: "#111111",
              surface0: "#ffffff",
              surface1: "#f7f7f7",
              surface2: "#eeeeee",
              surfaceSidebarHover: "#f2f2f2",
            },
            colorScheme: "light",
            fontSize: { xs: 12, sm: 14 },
            fontWeight: { medium: "500", normal: "400" },
            iconSize: { md: 20 },
            shadow: { md: {} },
            spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
          })
        : factory,
  },
  useUnistyles: () => ({
    theme: {},
    rt: {},
    breakpoint: undefined,
  }),
  withUnistyles: (Component: unknown) => Component,
  UnistylesRuntime: {
    setTheme: vi.fn(),
    themeName: "light",
  },
}));

import {
  createSidebarWorkspaceEntry,
  type SidebarProjectEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarWorkspacesList } from "@/hooks/use-sidebar-workspaces-list";
import { SidebarWorkspaceList } from "@/components/sidebar-workspace-list";
import { patchWorkspaceScripts } from "@/contexts/session-workspace-scripts";
import {
  getHostRuntimeStore,
  type HostRuntimeController,
  type HostRuntimeSnapshot,
} from "@/runtime/host-runtime";
import type { HostProfile } from "@/types/host-connection";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

const SERVER_ID = "sidebar-render-count";

interface RenderCounts {
  frame: number;
  headers: Record<string, number>;
  rows: Record<string, number>;
  projectSelection: Record<string, number>;
  rowSelection: Record<string, number>;
}

const runningScript: WorkspaceScriptPayload = {
  scriptName: "web",
  type: "service",
  hostname: "web.paseo.localhost",
  port: 3000,
  proxyUrl: "http://web.paseo.localhost:6767",
  lifecycle: "running",
  health: "healthy",
  exitCode: null,
  terminalId: null,
};

function workspace(input: {
  id: string;
  projectId: string;
  projectDisplayName: string;
  name: string;
  status?: WorkspaceDescriptor["status"];
  scripts?: WorkspaceDescriptor["scripts"];
}): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: input.projectId,
    projectDisplayName: input.projectDisplayName,
    projectRootPath: `/repo/${input.projectId}`,
    workspaceDirectory: `/repo/${input.projectId}/${input.id}`,
    projectKind: "git",
    workspaceKind: input.name === "main" ? "local_checkout" : "worktree",
    name: input.name,
    status: input.status ?? "done",
    archivingAt: null,
    diffStat: null,
    scripts: input.scripts ?? [],
  };
}

function createWorkspaces(): WorkspaceDescriptor[] {
  return [
    workspace({
      id: "a-main",
      projectId: "project-a",
      projectDisplayName: "Project A",
      name: "main",
      scripts: [runningScript],
    }),
    workspace({
      id: "a-one",
      projectId: "project-a",
      projectDisplayName: "Project A",
      name: "one",
    }),
    workspace({
      id: "a-two",
      projectId: "project-a",
      projectDisplayName: "Project A",
      name: "two",
    }),
    workspace({
      id: "b-main",
      projectId: "project-b",
      projectDisplayName: "Project B",
      name: "main",
    }),
    workspace({
      id: "b-one",
      projectId: "project-b",
      projectDisplayName: "Project B",
      name: "one",
    }),
    workspace({
      id: "b-two",
      projectId: "project-b",
      projectDisplayName: "Project B",
      name: "two",
    }),
  ];
}

function makeHost(): HostProfile {
  const now = "2026-04-19T00:00:00.000Z";
  return {
    serverId: SERVER_ID,
    label: "Render Count Host",
    lifecycle: {},
    connections: [],
    preferredConnectionId: null,
    createdAt: now,
    updatedAt: now,
  };
}

function initializeSidebarState(workspaces: WorkspaceDescriptor[]): void {
  act(() => {
    getHostRuntimeStore().syncHosts([makeHost()]);
    useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
    useSessionStore
      .getState()
      .setWorkspaces(SERVER_ID, new Map(workspaces.map((entry) => [entry.id, entry])));
    useSessionStore.getState().setHasHydratedWorkspaces(SERVER_ID, true);
    useSidebarOrderStore.setState({
      projectOrderByServerId: {
        [SERVER_ID]: ["project-a", "project-b"],
      },
      workspaceOrderByServerAndProject: {
        [`${SERVER_ID}::project-a`]: [
          `${SERVER_ID}:a-main`,
          `${SERVER_ID}:a-one`,
          `${SERVER_ID}:a-two`,
        ],
        [`${SERVER_ID}::project-b`]: [
          `${SERVER_ID}:b-main`,
          `${SERVER_ID}:b-one`,
          `${SERVER_ID}:b-two`,
        ],
      },
    });
  });
}

function resetCounts(counts: RenderCounts): void {
  counts.frame = 0;
  counts.headers = {};
  counts.rows = {};
  counts.projectSelection = {};
  counts.rowSelection = {};
}

function incrementRecord(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function ProjectHeaderProbe({
  project,
  counts,
}: {
  project: SidebarProjectEntry;
  counts: RenderCounts;
}): null {
  incrementRecord(counts.headers, project.projectKey);
  return null;
}

function WorkspaceRowProbe({
  serverId,
  workspaceId,
  counts,
}: {
  serverId: string;
  workspaceId: string;
  counts: RenderCounts;
}): null {
  const workspaceEntry = useWorkspaceFields(serverId, workspaceId, (entry) =>
    createSidebarWorkspaceEntry({ serverId, workspace: entry }),
  );
  if (workspaceEntry) {
    incrementRecord(counts.rows, workspaceEntry.workspaceId);
  }
  return null;
}

function ProjectActiveProbe({
  serverId,
  project,
  counts,
}: {
  serverId: string;
  project: SidebarProjectEntry;
  counts: RenderCounts;
}): null {
  const activeSelection = useActiveWorkspaceSelection();
  const isActive =
    activeSelection?.serverId === serverId &&
    project.workspaces.some((entry) => entry.workspaceId === activeSelection.workspaceId);
  void isActive;
  incrementRecord(counts.projectSelection, project.projectKey);
  return null;
}

function WorkspaceSelectionProbe({
  serverId,
  workspaceId,
  counts,
}: {
  serverId: string;
  workspaceId: string;
  counts: RenderCounts;
}): null {
  const activeSelection = useActiveWorkspaceSelection();
  const selected =
    activeSelection?.serverId === serverId && activeSelection.workspaceId === workspaceId;
  void selected;
  incrementRecord(counts.rowSelection, workspaceId);
  return null;
}

function SidebarFrameProbe({ counts }: { counts: RenderCounts }): ReactElement {
  counts.frame += 1;
  const { projects } = useSidebarWorkspacesList({ serverId: SERVER_ID });

  return (
    <>
      {projects.map((project) => (
        <div key={project.projectKey}>
          <ProjectHeaderProbe project={project} counts={counts} />
          <ProjectActiveProbe serverId={SERVER_ID} project={project} counts={counts} />
          {project.workspaces.map((entry) => (
            <React.Fragment key={entry.workspaceKey}>
              <WorkspaceRowProbe
                serverId={entry.serverId}
                workspaceId={entry.workspaceId}
                counts={counts}
              />
              <WorkspaceSelectionProbe
                serverId={entry.serverId}
                workspaceId={entry.workspaceId}
                counts={counts}
              />
            </React.Fragment>
          ))}
        </div>
      ))}
    </>
  );
}

function getHostController(): HostRuntimeController {
  const controllers = (
    getHostRuntimeStore() as unknown as {
      controllers: Map<string, HostRuntimeController>;
    }
  ).controllers;
  const controller = controllers.get(SERVER_ID);
  if (!controller) {
    throw new Error("Host runtime controller was not initialized");
  }
  return controller;
}

function updateControllerSnapshot(
  patch: Partial<Omit<HostRuntimeSnapshot, "serverId" | "clientGeneration">>,
): void {
  (
    getHostController() as unknown as {
      updateSnapshot: (
        patch: Partial<Omit<HostRuntimeSnapshot, "serverId" | "clientGeneration">>,
      ) => void;
    }
  ).updateSnapshot(patch);
}

async function renderProbe(counts: RenderCounts): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    renderSidebarFrame(root, counts);
  });
  resetCounts(counts);
  return { root, container };
}

function renderSidebarFrame(root: Root, counts: RenderCounts) {
  root.render(<SidebarFrameProbe counts={counts} />);
}

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

function SidebarWorkspaceListHarness({
  projects,
  collapsedProjectKeys,
}: {
  projects: SidebarProjectEntry[];
  collapsedProjectKeys: ReadonlySet<string>;
}): ReactElement {
  return (
    <SidebarWorkspaceList
      projects={projects}
      serverId={SERVER_ID}
      collapsedProjectKeys={collapsedProjectKeys}
      onToggleProjectCollapsed={vi.fn()}
      shortcutIndexByWorkspaceKey={new Map()}
    />
  );
}

function createSidebarProjectsFixture(): SidebarProjectEntry[] {
  const workspaces = useSessionStore.getState().sessions[SERVER_ID]?.workspaces;
  const projectAWorkspaces = ["a-main", "a-one", "a-two"]
    .map((id) => workspaces?.get(id))
    .filter((entry): entry is WorkspaceDescriptor => Boolean(entry))
    .map((entry) => createSidebarWorkspaceEntry({ serverId: SERVER_ID, workspace: entry }));

  return [
    {
      projectKey: "project-a",
      projectName: "Project A",
      projectKind: "git",
      iconWorkingDir: "/repo/project-a",
      workspaces: projectAWorkspaces,
    },
  ];
}

async function renderWorkspaceList(input?: {
  collapsedProjectKeys?: ReadonlySet<string>;
}): Promise<{ root: Root; container: HTMLElement; queryClient: QueryClient }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = createTestQueryClient();
  const projects = createSidebarProjectsFixture();

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SidebarWorkspaceListHarness
          projects={projects}
          collapsedProjectKeys={input?.collapsedProjectKeys ?? new Set()}
        />
      </QueryClientProvider>,
    );
  });

  return { root, container, queryClient };
}

function resetWorkspaceLayoutStore(): void {
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    splitSizesByWorkspace: {},
    pinnedAgentIdsByWorkspace: {},
    hiddenAgentIdsByWorkspace: {},
    focusRestorationByWorkspace: {},
  });
}

describe("sidebar workspace row actions", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  let queryClient: QueryClient | null = null;

  beforeEach(() => {
    initializeSidebarState(createWorkspaces());
    resetWorkspaceLayoutStore();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
    queryClient?.clear();
    queryClient = null;
    act(() => {
      pathnameState.value = "/";
      getHostRuntimeStore().syncHosts([]);
      useSessionStore.getState().clearSession(SERVER_ID);
      useSidebarOrderStore.setState({
        projectOrderByServerId: {},
        workspaceOrderByServerAndProject: {},
      });
      resetWorkspaceLayoutStore();
    });
  });

  it("shows the new-agent action only on worktree rows", async () => {
    ({ root, container, queryClient } = await renderWorkspaceList());

    expect(
      container.querySelector(
        '[data-testid="sidebar-workspace-new-agent-sidebar-render-count:a-one"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="sidebar-workspace-new-agent-sidebar-render-count:a-main"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid^="sidebar-project-new-worktree-"]'),
    ).not.toBeNull();
  });

  it("opens a fresh draft tab for the selected worktree action", async () => {
    ({ root, container, queryClient } = await renderWorkspaceList());

    const row = container.querySelector(
      '[data-testid="sidebar-workspace-row-sidebar-render-count:a-one"]',
    );
    if (!(row instanceof HTMLElement) || !(row.parentElement instanceof HTMLElement)) {
      throw new Error("Expected worktree row to render");
    }

    await act(async () => {
      fireEvent.pointerEnter(row.parentElement);
    });

    const button = container.querySelector(
      '[data-testid="sidebar-workspace-new-agent-sidebar-render-count:a-one"]',
    );
    if (!(button instanceof HTMLElement)) {
      throw new Error("Expected worktree new-agent button to render");
    }

    await act(async () => {
      button.click();
    });

    const tabs = useWorkspaceLayoutStore.getState().getWorkspaceTabs(`${SERVER_ID}:a-one`);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.target.kind).toBe("draft");
    expect(tabs[0]?.target.kind === "draft" ? tabs[0].target.draftId : null).not.toBe("new");
  });
});

describe("sidebar workspace render isolation", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(async () => {
    initializeSidebarState(createWorkspaces());
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
    act(() => {
      pathnameState.value = "/";
      getHostRuntimeStore().syncHosts([]);
      useSessionStore.getState().clearSession(SERVER_ID);
      useSidebarOrderStore.setState({
        projectOrderByServerId: {},
        workspaceOrderByServerAndProject: {},
      });
    });
  });

  it("re-renders only the changed workspace row for a status update", async () => {
    const counts: RenderCounts = {
      frame: 0,
      headers: {},
      rows: {},
      projectSelection: {},
      rowSelection: {},
    };
    ({ root, container } = await renderProbe(counts));

    act(() => {
      useSessionStore.getState().mergeWorkspaces(SERVER_ID, [
        {
          ...createWorkspaces()[1],
          status: "running",
        },
      ]);
    });

    expect(counts.frame).toBe(0);
    expect(counts.headers).toEqual({});
    expect(counts.rows).toEqual({ "a-one": 1 });
  });

  it("does not re-render the sidebar for a host-runtime probe tick with no content change", async () => {
    const counts: RenderCounts = {
      frame: 0,
      headers: {},
      rows: {},
      projectSelection: {},
      rowSelection: {},
    };
    ({ root, container } = await renderProbe(counts));

    act(() => {
      const probeByConnectionId = getHostController().getSnapshot().probeByConnectionId;
      updateControllerSnapshot({
        probeByConnectionId: new Map(probeByConnectionId),
      });
    });

    expect(counts).toEqual({
      frame: 0,
      headers: {},
      rows: {},
      projectSelection: {},
      rowSelection: {},
    });
  });

  it("does not re-render for a deep-equal scripts patch", async () => {
    const counts: RenderCounts = {
      frame: 0,
      headers: {},
      rows: {},
      projectSelection: {},
      rowSelection: {},
    };
    ({ root, container } = await renderProbe(counts));

    const applyRunningScript = (current: Parameters<typeof patchWorkspaceScripts>[0]) =>
      patchWorkspaceScripts(current, {
        workspaceId: "a-main",
        scripts: [{ ...runningScript }],
      });

    act(() => {
      useSessionStore.getState().setWorkspaces(SERVER_ID, applyRunningScript);
    });

    expect(counts).toEqual({
      frame: 0,
      headers: {},
      rows: {},
      projectSelection: {},
      rowSelection: {},
    });
  });

  it("updates active selection probes from the active workspace route", async () => {
    const counts: RenderCounts = {
      frame: 0,
      headers: {},
      rows: {},
      projectSelection: {},
      rowSelection: {},
    };

    act(() => {
      pathnameState.value = `/h/${SERVER_ID}/workspace/a-one`;
    });
    ({ root, container } = await renderProbe(counts));

    act(() => {
      pathnameState.value = `/h/${SERVER_ID}/workspace/b-two`;
      if (root) {
        renderSidebarFrame(root, counts);
      }
    });

    expect(counts.frame).toBe(1);
    expect(counts.projectSelection).toEqual({
      "project-a": 1,
      "project-b": 1,
    });
    expect(counts.rowSelection).toEqual({
      "a-main": 1,
      "a-one": 1,
      "a-two": 1,
      "b-main": 1,
      "b-one": 1,
      "b-two": 1,
    });
  });
});
