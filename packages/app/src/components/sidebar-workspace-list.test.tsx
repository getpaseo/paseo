/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { useLimitedSidebarGroup } from "@/components/sidebar/use-limited-sidebar-group";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceScriptPayload } from "@getpaseo/protocol/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React from "react";
import type { ReactElement } from "react";
import { createProjectViewKey } from "@/projects/workspace-structure";

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

const pathnameState = vi.hoisted(() => ({
  value: "/",
}));

vi.mock("expo-router", () => ({
  router: {
    dismissTo: vi.fn(),
  },
  useLocalSearchParams: () => ({}),
  usePathname: () => pathnameState.value,
}));

import {
  createSidebarWorkspaceEntry,
  type SidebarProjectEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarWorkspacesList } from "@/hooks/use-sidebar-workspaces-list";
import {
  getHostRuntimeStore,
  type HostRuntimeController,
  type HostRuntimeSnapshot,
} from "@/runtime/host-runtime";
import type { HostProfile } from "@/types/host-connection";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { seedRuntimeWorkspaces } from "@/test/seed-session";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { defaultHostAppearance } from "@/hosts/appearance";

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
    createdAt: null,
    lastUserMessageAt: null,
    id: input.id,
    projectId: input.projectId,
    projectDisplayName: input.projectDisplayName,
    projectRootPath: `/repo/${input.projectId}`,
    workspaceDirectory: `/repo/${input.projectId}/${input.id}`,
    projectKind: "git",
    workspaceKind: input.name === "main" ? "local_checkout" : "worktree",
    name: input.name,
    status: input.status ?? "done",
    statusEnteredAt: null,
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
    appearance: defaultHostAppearance(),
    lifecycle: {},
    connections: [],
    preferredConnectionId: null,
    createdAt: now,
    updatedAt: now,
  };
}

function setHostProfiles(hosts: HostProfile[]): void {
  (
    getHostRuntimeStore() as unknown as {
      setHostsAndSync: (hosts: HostProfile[]) => void;
    }
  ).setHostsAndSync(hosts);
}

function initializeSidebarState(workspaces: WorkspaceDescriptor[]): void {
  act(() => {
    setHostProfiles([makeHost()]);
    useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
    seedRuntimeWorkspaces(SERVER_ID, new Map(workspaces.map((entry) => [entry.id, entry])));
    useSessionStore.getState().setHasHydratedWorkspaces(SERVER_ID, true);
    useSidebarOrderStore.setState({
      projectOrder: ["project-a", "project-b"],
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
  incrementRecord(counts.headers, project.viewKey);
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
  incrementRecord(counts.projectSelection, project.viewKey);
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
  const { projects } = useSidebarWorkspacesList({ hostFilters: [SERVER_ID] });

  return (
    <>
      {projects.map((project) => (
        <div key={project.viewKey}>
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
      setHostProfiles([]);
      useSessionStore.getState().clearSession(SERVER_ID);
      useSidebarOrderStore.setState({
        projectOrder: [],
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
      [createProjectViewKey({ kind: "equivalence", projectKey: "project-a" })]: 1,
      [createProjectViewKey({ kind: "equivalence", projectKey: "project-b" })]: 1,
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

describe("sidebar group visibility", () => {
  const entries = (statuses: WorkspaceDescriptor["status"][]) =>
    statuses.map((status, index) =>
      createSidebarWorkspaceEntry({
        serverId: SERVER_ID,
        workspace: workspace({
          id: `row-${index + 1}`,
          projectId: "project-a",
          projectDisplayName: "Project A",
          name: `Row ${index + 1}`,
          status,
        }),
      }),
    );
  const policy = {
    kind: "workspaces" as const,
    getStatusBucket: (entry: ReturnType<typeof createSidebarWorkspaceEntry>) => entry.statusBucket,
  };
  const names = (items: readonly ReturnType<typeof createSidebarWorkspaceEntry>[]) =>
    items.map((item) => item.workspaceId);

  it.each([0, 7, 8])("limits %i Done rows to seven", (count) => {
    const items = entries(Array(count).fill("done"));
    const { result } = renderHook(() => useLimitedSidebarGroup(items, policy));
    expect(result.current.visibleItems).toEqual(items.slice(0, 7));
    expect(result.current.canToggle).toBe(count > 7);
  });

  it.each(["needs_input", "failed", "attention", "running"] as const)(
    "keeps row twelve visible for %s without filling gaps",
    (status) => {
      const items = entries([...Array(11).fill("done"), status]);
      const { result } = renderHook(() => useLimitedSidebarGroup(items, policy));
      expect(names(result.current.visibleItems)).toEqual([
        "row-1",
        "row-2",
        "row-3",
        "row-4",
        "row-5",
        "row-6",
        "row-7",
        "row-12",
      ]);
      expect(result.current.visibleItems[7]).toBe(items[11]);
      expect(result.current.canToggle).toBe(true);
    },
  );

  it("shows eight active rows once with no redundant toggle", () => {
    const items = entries([
      "running",
      "needs_input",
      "attention",
      "failed",
      "running",
      "attention",
      "needs_input",
      "failed",
    ]);
    const { result } = renderHook(() => useLimitedSidebarGroup(items, policy));
    expect(result.current.visibleItems).toEqual(items);
    expect(result.current.canToggle).toBe(false);
  });

  it("recomputes current ordered membership and retains reveal through status, order and size changes", () => {
    const items = entries([
      ...Array(7).fill("done"),
      "running",
      "done",
      "failed",
      "done",
      "attention",
    ]);
    const { result, rerender, unmount } = renderHook(
      ({ rows }) => useLimitedSidebarGroup(rows, policy),
      { initialProps: { rows: items } },
    );
    expect(names(result.current.visibleItems)).toEqual([
      "row-1",
      "row-2",
      "row-3",
      "row-4",
      "row-5",
      "row-6",
      "row-7",
      "row-8",
      "row-10",
      "row-12",
    ]);
    act(() => result.current.toggleExpanded());
    expect(result.current.visibleItems).toEqual(items);
    rerender({ rows: items.map((item) => ({ ...item, statusBucket: "running" })) });
    expect(result.current.canToggle).toBe(false);
    expect(result.current.expanded).toBe(true);
    rerender({ rows: items.slice(0, 3) });
    expect(result.current.canToggle).toBe(false);
    rerender({ rows: items.toReversed() });
    expect(result.current.visibleItems).toEqual(items.toReversed());
    act(() => result.current.toggleExpanded());
    expect(names(result.current.visibleItems)).toEqual([
      "row-12",
      "row-11",
      "row-10",
      "row-9",
      "row-8",
      "row-7",
      "row-6",
    ]);
    const newest = { ...items[0], workspaceId: "new", workspaceKey: "srv:new" };
    rerender({ rows: [newest, ...items] });
    expect(result.current.visibleItems[0]).toBe(newest);
    expect(result.current.visibleItems).toHaveLength(10);
    expect(result.current.expanded).toBe(false);
    act(() => result.current.toggleExpanded());
    unmount();
    const remounted = renderHook(() => useLimitedSidebarGroup(items, policy));
    expect(remounted.result.current.expanded).toBe(false);
    expect(remounted.result.current.visibleItems).toHaveLength(10);
  });

  it("follows effective pending creation, recovery and agent activity without changing Created order", () => {
    const items = entries(Array(12).fill("done"));
    const descriptor = workspace({
      id: "row-12",
      projectId: "project-a",
      projectDisplayName: "Project A",
      name: "Row 12",
    });
    const pending = {
      draftId: "draft",
      serverId: SERVER_ID,
      workspaceId: descriptor.id,
      agentId: null,
      clientMessageId: "message",
      text: "Create",
      timestamp: 1234,
      lifecycle: "active" as const,
    };
    const { result, rerender } = renderHook(
      ({ last }) => useLimitedSidebarGroup([...items.slice(0, 11), last], policy),
      { initialProps: { last: items[11] } },
    );
    expect(result.current.visibleItems).toHaveLength(7);
    const creating = createSidebarWorkspaceEntry({
      serverId: SERVER_ID,
      workspace: descriptor,
      pendingCreateAttempts: { draft: pending },
    });
    expect(creating.statusBucket).toBe("running");
    rerender({ last: creating });
    expect(names(result.current.visibleItems)).toEqual([...names(items.slice(0, 7)), "row-12"]);
    const abandoned = createSidebarWorkspaceEntry({
      serverId: SERVER_ID,
      workspace: descriptor,
      pendingCreateAttempts: { draft: { ...pending, lifecycle: "abandoned" } },
    });
    rerender({ last: abandoned });
    expect(result.current.visibleItems).toHaveLength(7);
    rerender({ last: creating });
    for (const status of ["running", "attention", "needs_input", "failed", "done"] as const) {
      const last = createSidebarWorkspaceEntry({
        serverId: SERVER_ID,
        workspace: descriptor,
        workspaceAgentActivity: new Map([
          [descriptor.id, { agentId: "agent", status, enteredAt: null }],
        ]),
      });
      expect(last.statusBucket).toBe(status);
      rerender({ last });
      expect(names(result.current.visibleItems)).toEqual(
        status === "done" ? names(items.slice(0, 7)) : [...names(items.slice(0, 7)), "row-12"],
      );
    }
  });

  it("preserves the twenty-row pinned policy regardless of status", () => {
    const items = entries(Array(21).fill("running"));
    const { result } = renderHook(() => useLimitedSidebarGroup(items));
    expect(result.current.visibleItems).toEqual(items.slice(0, 20));
    expect(result.current.canToggle).toBe(true);
    act(() => result.current.toggleExpanded());
    expect(result.current.visibleItems).toEqual(items);
    act(() => result.current.toggleExpanded());
    expect(result.current.visibleItems).toHaveLength(20);
  });
});
