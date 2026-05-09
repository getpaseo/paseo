/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import React from "react";
import { useCallback, useMemo } from "react";
import { Pressable, View } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shallow } from "zustand/shallow";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type { DaemonClient } from "@server/client/daemon-client";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useSessionStore, type Agent } from "@/stores/session-store";
import {
  SidebarSessionGroupFooter,
  SidebarSessionGroupHeader,
  useGroupedSidebarSessionGroups,
  useOrderedAgentProjectShape,
} from "./grouped-view";
import { selectSidebarSessionSlice } from "./select-sidebar-session-slice";

function gitProject(key: string): SidebarProjectEntry {
  return {
    projectKey: key,
    projectName: `Project ${key}`,
    projectKind: "git",
    iconWorkingDir: `/repo/${key}`,
    workspaces: [
      {
        workspaceKey: `server-1:${key}-ws`,
        serverId: "server-1",
        workspaceId: `${key}-ws`,
        projectKey: key,
        projectRootPath: `/repo/${key}`,
        workspaceDirectory: `/repo/${key}/ws`,
        projectKind: "git",
        workspaceKind: "checkout",
        name: `${key}-ws`,
        statusBucket: "done",
        archivingAt: null,
        diffStat: null,
        scripts: [],
        hasRunningScripts: false,
      },
    ],
  };
}

const HARNESS_PROJECTS: readonly SidebarProjectEntry[] = [
  gitProject("project-a"),
  gitProject("project-b"),
];

vi.hoisted(() => {
  Object.assign(globalThis, { __DEV__: false });
});

const { routerNavigateMock } = vi.hoisted(() => ({
  routerNavigateMock: vi.fn(),
}));

vi.mock("@/hooks/use-project-icon-query", () => ({
  useProjectIconQuery: () => ({ icon: null, isLoading: false, isError: false }),
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": name });
  return {
    ChevronDown: createIcon("ChevronDown"),
    ChevronRight: createIcon("ChevronRight"),
    FolderPlus: createIcon("FolderPlus"),
    MoreVertical: createIcon("MoreVertical"),
    Plus: createIcon("Plus"),
    Settings: createIcon("Settings"),
    Trash2: createIcon("Trash2"),
  };
});

vi.mock("expo-router", () => ({
  router: {
    navigate: routerNavigateMock,
  },
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
  DropdownMenuItem: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
    <View testID={testID}>{children}</View>
  ),
  DropdownMenuTrigger: ({
    children,
    testID,
  }: {
    children: React.ReactNode | ((state: { hovered: boolean }) => React.ReactNode);
    testID?: string;
  }) => (
    <Pressable testID={testID}>
      {typeof children === "function" ? children({ hovered: false }) : children}
    </Pressable>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/components/ui/shortcut", () => ({
  Shortcut: () => <View />,
}));

vi.mock("@/constants/platform", () => ({
  isNative: false,
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => false,
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: vi.fn() }),
}));

vi.mock("@/hooks/use-shortcut-keys", () => ({
  useShortcutKeys: () => null,
}));

const TIMESTAMP = new Date("2026-05-08T10:00:00.000Z");
const SERVER_ID = "server-1";

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (styles: unknown) =>
      typeof styles === "function"
        ? styles({
            borderRadius: { lg: 8, md: 6, sm: 4 },
            colors: {
              border: "#dddddd",
              foreground: "#111111",
              foregroundMuted: "#666666",
              surface2: "#eeeeee",
              surfaceSidebarHover: "#f5f5f5",
            },
            fontSize: { sm: 14, xs: 12 },
            iconSize: { md: 20 },
            shadow: { md: {} },
            spacing: { 1: 4, 2: 8, 3: 12 },
          })
        : styles,
  },
  withUnistyles: (Component: React.ComponentType<Record<string, unknown>>) =>
    function ThemedComponent(props: Record<string, unknown>) {
      return <Component {...props} />;
    },
}));

const AGENT_DEFAULTS: Agent = {
  serverId: "server-1",
  id: "agent-1",
  provider: "codex",
  status: "running",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  lastUserMessageAt: null,
  lastActivityAt: TIMESTAMP,
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
  runtimeInfo: undefined,
  lastUsage: undefined,
  lastError: null,
  title: "Agent",
  cwd: "/repo/main",
  model: null,
  thinkingOptionId: undefined,
  requiresAttention: false,
  attentionReason: null,
  attentionTimestamp: null,
  archivedAt: null,
  labels: {},
  projectPlacement: null,
};

function makeAgent(input: Partial<Agent> = {}): Agent {
  return { ...AGENT_DEFAULTS, ...input };
}

function seedAgent(agent: Agent) {
  useSessionStore.getState().initializeSession(SERVER_ID, {} as unknown as DaemonClient);
  useSessionStore.getState().setAgents(SERVER_ID, new Map([[agent.id, agent]]));
}

function seedAgents(agents: Agent[]) {
  useSessionStore.getState().initializeSession(SERVER_ID, {} as unknown as DaemonClient);
  useSessionStore
    .getState()
    .setAgents(SERVER_ID, new Map(agents.map((agent) => [agent.id, agent])));
}

function useGroupedBoundaryHarness(input?: { collapsedProjectKeys?: ReadonlySet<string> }) {
  const orderedIds = useStoreWithEqualityFn(
    useSessionStore,
    (state) => Array.from(state.sessions[SERVER_ID]?.agents?.keys() ?? []),
    shallow,
  );
  const resolveCwdToProject = useCallback((cwd: string) => {
    if (cwd === "/repo/b") {
      return { projectKey: "project-b", projectName: "Project B", projectIconKey: "/repo/b" };
    }
    return { projectKey: "project-a", projectName: "Project A", projectIconKey: "/repo/a" };
  }, []);
  const agentsWithProjects = useOrderedAgentProjectShape({
    orderedIds,
    serverId: SERVER_ID,
    resolveCwdToProject,
  });
  const previewExpandedProjects = useMemo(() => new Set<string>(), []);
  const fallbackCollapsed = useMemo(() => new Set<string>(), []);
  const collapsedProjectKeys = input?.collapsedProjectKeys ?? fallbackCollapsed;

  return useGroupedSidebarSessionGroups({
    agentsWithProjects,
    projects: HARNESS_PROJECTS,
    previewExpandedProjects,
    collapsedProjectKeys,
  });
}

afterEach(() => {
  cleanup();
  useSessionStore.setState({ sessions: {}, agentLastActivity: new Map() });
  routerNavigateMock.mockClear();
});

describe("sidebar session render boundaries", () => {
  it("changes the row slice when lastActivityAt changes", () => {
    const beforeAgent = makeAgent();
    seedAgent(beforeAgent);

    const beforeSlice = selectSidebarSessionSlice(
      useSessionStore.getState(),
      "server-1",
      "agent-1",
    );

    const afterAgent = makeAgent({
      lastActivityAt: new Date("2026-05-08T11:00:00.000Z"),
    });
    useSessionStore.getState().setAgents("server-1", new Map([["agent-1", afterAgent]]));

    const afterSlice = selectSidebarSessionSlice(useSessionStore.getState(), "server-1", "agent-1");

    expect(shallow(beforeSlice, afterSlice)).toBe(false);
  });

  it("does not change the row slice for fields the row does not consume", () => {
    seedAgent(makeAgent());

    const beforeSlice = selectSidebarSessionSlice(
      useSessionStore.getState(),
      "server-1",
      "agent-1",
    );

    useSessionStore.getState().setAgents(
      "server-1",
      new Map([
        [
          "agent-1",
          makeAgent({
            status: "idle",
            createdAt: new Date("2026-05-08T11:00:00.000Z"),
            requiresAttention: true,
          }),
        ],
      ]),
    );

    const afterSlice = selectSidebarSessionSlice(useSessionStore.getState(), "server-1", "agent-1");

    expect(shallow(beforeSlice, afterSlice)).toBe(true);
  });

  it("keeps grouped section data stable when activity changes without reordering ids", () => {
    seedAgents([makeAgent({ id: "agent-1" }), makeAgent({ id: "agent-2", cwd: "/repo/main-2" })]);

    const { result } = renderHook(() => useGroupedBoundaryHarness());
    const beforeGroups = result.current;

    act(() => {
      useSessionStore.getState().setAgents(
        SERVER_ID,
        new Map([
          [
            "agent-1",
            makeAgent({
              id: "agent-1",
              lastActivityAt: new Date("2026-05-08T11:00:00.000Z"),
            }),
          ],
          ["agent-2", makeAgent({ id: "agent-2", cwd: "/repo/main-2" })],
        ]),
      );
    });

    expect(result.current).toBe(beforeGroups);
  });

  it("changes grouped section data when cwd resolves to a different project", () => {
    seedAgents([makeAgent({ id: "agent-1", cwd: "/repo/a" })]);

    const { result } = renderHook(() => useGroupedBoundaryHarness());
    const beforeGroups = result.current;

    act(() => {
      useSessionStore
        .getState()
        .setAgents(SERVER_ID, new Map([["agent-1", makeAgent({ id: "agent-1", cwd: "/repo/b" })]]));
    });

    expect(result.current).not.toBe(beforeGroups);
    expect(result.current[0]).toMatchObject({
      projectKey: "project-b",
      visibleIds: ["agent-1"],
    });
  });

  it("keeps grouped section data stable when cwd changes but resolves to the same project", () => {
    seedAgents([makeAgent({ id: "agent-1", cwd: "/repo/a" })]);

    const { result } = renderHook(() => useGroupedBoundaryHarness());
    const beforeGroups = result.current;

    act(() => {
      useSessionStore
        .getState()
        .setAgents(
          SERVER_ID,
          new Map([["agent-1", makeAgent({ id: "agent-1", cwd: "/repo/a-worktree" })]]),
        );
    });

    expect(result.current).toBe(beforeGroups);
  });

  it("emits a collapsed group with no visible ids and zero hidden count", () => {
    const overLimit = Array.from({ length: 10 }, (_, index) =>
      makeAgent({ id: `agent-${index + 1}`, cwd: "/repo/a" }),
    );
    seedAgents(overLimit);

    const { result } = renderHook(() =>
      useGroupedBoundaryHarness({ collapsedProjectKeys: new Set(["project-a"]) }),
    );

    expect(result.current).toEqual([
      expect.objectContaining({
        projectKey: "project-a",
        isCollapsed: true,
        visibleIds: [],
        hiddenCount: 0,
        totalCount: 10,
      }),
    ]);
  });

  it("calls the grouped footer press handler with its project key", () => {
    const onPress = vi.fn();

    const { getByTestId } = render(
      <SidebarSessionGroupFooter
        projectKey="project-a"
        hiddenCount={2}
        isExpanded={false}
        onPress={onPress}
      />,
    );

    fireEvent.click(getByTestId("sidebar-session-group-footer-project-a"));

    expect(onPress).toHaveBeenCalledWith("project-a");
  });

  it("renders the project kebab and new-session button in the grouped header", () => {
    const { getByTestId } = render(
      <SidebarSessionGroupHeader
        serverId="server-1"
        projectKey="project-a"
        projectName="Project A"
        projectIconKey="/repo/a"
        workspaces={HARNESS_PROJECTS[0].workspaces}
        isCollapsed={false}
        onToggleCollapsed={vi.fn()}
      />,
    );

    expect(getByTestId("sidebar-project-kebab-project-a")).toBeTruthy();
    expect(getByTestId("sidebar-project-project-a-new-session-button")).toBeTruthy();
  });

  it("opens a new session scoped to the grouped project root", () => {
    const { getByTestId } = render(
      <SidebarSessionGroupHeader
        serverId="server-1"
        projectKey="project-a"
        projectName="Project A"
        projectIconKey="/repo/a"
        workspaces={HARNESS_PROJECTS[0].workspaces}
        isCollapsed={false}
        onToggleCollapsed={vi.fn()}
      />,
    );

    fireEvent.click(getByTestId("sidebar-project-project-a-new-session-button"));

    expect(routerNavigateMock).toHaveBeenCalledWith(
      "/h/server-1/new?dir=%2Frepo%2Fa&title=New+session",
    );
  });
});
