/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { DaemonClient } from "@server/client/daemon-client";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useSessionStore, type Agent, type WorkspaceDescriptor } from "@/stores/session-store";
import { SidebarSessionsView } from "./view";

vi.hoisted(() => {
  Object.assign(globalThis, { __DEV__: false });
});

const {
  aggregatedAgentsState,
  navigateToPreparedWorkspaceTabMock,
  prepareWorkspaceTabMock,
  testTheme,
} = vi.hoisted(() => ({
  aggregatedAgentsState: {
    value: {
      agents: [] as unknown[],
      isInitialLoad: false,
    },
  },
  navigateToPreparedWorkspaceTabMock: vi.fn(),
  prepareWorkspaceTabMock: vi.fn(),
  testTheme: {
    borderRadius: { full: 999, lg: 8 },
    colors: {
      foreground: "#111111",
      foregroundMuted: "#666666",
      palette: {
        amber: { 500: "#f59e0b", 700: "#b45309" },
        blue: { 500: "#3b82f6" },
        green: { 500: "#22c55e" },
        red: { 500: "#ef4444" },
      },
      surface0: "#ffffff",
      surface2: "#eeeeee",
      surfaceSidebarHover: "#f5f5f5",
    },
    colorScheme: "light",
    fontSize: { sm: 14, xs: 12 },
    fontWeight: { medium: "500" },
    iconSize: { md: 20, sm: 16 },
    shadow: { md: {} },
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
  },
}));

vi.mock("@/hooks/use-aggregated-agents", () => ({
  useAggregatedAgentIds: (options?: { filter?: (agent: AggregatedAgent) => boolean }) =>
    aggregatedAgentsState.value.agents
      .filter((agent) => !options?.filter || options.filter(agent as AggregatedAgent))
      .map((agent) => (agent as AggregatedAgent).id),
  useAggregatedAgentsInitialLoad: () => aggregatedAgentsState.value.isInitialLoad,
}));

vi.mock("@/components/provider-icons", async () => {
  const ReactModule = await import("react");
  return {
    getProviderIcon: () =>
      function ProviderIcon() {
        return ReactModule.createElement("span", { "data-testid": "provider-icon" });
      },
  };
});

vi.mock("./session-row-actions", () => ({
  SidebarSessionRowKebabMenu: () => null,
}));

vi.mock("@/components/sidebar/sidebar-project-trailing-actions", () => ({
  SidebarProjectTrailingActions: () => null,
}));

vi.mock("expo-router", () => ({
  router: {
    navigate: vi.fn(),
  },
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) =>
    function Icon({ uniProps: _uniProps, ...props }: Record<string, unknown>) {
      return React.createElement("span", { ...props, "data-icon": name });
    };
  return {
    Archive: createIcon("Archive"),
    ChevronDown: createIcon("ChevronDown"),
    ChevronRight: createIcon("ChevronRight"),
    FolderPlus: createIcon("FolderPlus"),
    MoreVertical: createIcon("MoreVertical"),
    Settings: createIcon("Settings"),
    Trash2: createIcon("Trash2"),
    X: createIcon("X"),
  };
});

vi.mock("@/screens/workspace/workspace-tab-presentation", async () => {
  const ReactModule = await import("react");
  return {
    WorkspaceTabPresentationResolver: ({ children }: { children: (presentation: {}) => unknown }) =>
      children({}),
    WorkspaceTabIcon: () =>
      ReactModule.createElement("span", { "data-testid": "workspace-tab-icon" }),
  };
});

vi.mock("react-native-draggable-flatlist", async () => {
  const ReactModule = await import("react");
  return {
    NestableScrollContainer: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement("div", null, children),
    default: () => null,
  };
});

vi.mock("react-native-reanimated", () => ({
  default: {
    View: "div",
  },
  Easing: {
    linear: vi.fn(),
  },
  makeMutable: (value: unknown) => ({ value }),
  useAnimatedStyle: (factory: () => unknown) => factory(),
  withRepeat: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (styles: (theme: unknown) => unknown) => styles(testTheme),
  },
  withUnistyles: (Component: unknown) => Component,
  useUnistyles: () => ({
    theme: testTheme,
    rt: {},
    breakpoint: undefined,
  }),
}));

vi.mock("@/utils/workspace-navigation", () => ({
  navigateToPreparedWorkspaceTab: navigateToPreparedWorkspaceTabMock,
  prepareWorkspaceTab: prepareWorkspaceTabMock,
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

const SERVER_ID = "server-1";
const WORKSPACE_ID = "workspace-1";
const AGENT_ID = "agent-1";
const CWD = "/repo/project/workspace";
const TIMESTAMP = new Date("2026-05-08T10:00:00.000Z");
const ALL_SESSIONS_FILTER = { type: "all" } as const;

const AGENT_DEFAULTS: Agent = {
  serverId: SERVER_ID,
  id: AGENT_ID,
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
  title: "Navigation agent",
  cwd: CWD,
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

function toAggregatedAgent(agent: Agent): AggregatedAgent {
  return {
    ...agent,
    serverLabel: "Server 1",
  };
}

function workspace(input: Partial<WorkspaceDescriptor> = {}): WorkspaceDescriptor {
  return {
    id: WORKSPACE_ID,
    projectId: "project-1",
    projectDisplayName: "Project",
    projectRootPath: "/repo/project",
    workspaceDirectory: CWD,
    projectKind: "git",
    workspaceKind: "worktree",
    name: "workspace",
    status: "done",
    archivingAt: null,
    diffStat: null,
    scripts: [],
    ...input,
  };
}

function projects(): SidebarProjectEntry[] {
  return [
    {
      projectKey: "project-1",
      projectName: "Project",
      projectKind: "git",
      iconWorkingDir: "/repo/project",
      workspaces: [
        {
          workspaceKey: `${SERVER_ID}:${WORKSPACE_ID}`,
          serverId: SERVER_ID,
          workspaceId: WORKSPACE_ID,
          projectKey: "project-1",
          projectRootPath: "/repo/project",
          workspaceDirectory: CWD,
          projectKind: "git",
          workspaceKind: "worktree",
          name: "workspace",
          statusBucket: "done",
          archivingAt: null,
          diffStat: null,
          scripts: [],
          hasRunningScripts: false,
        },
      ],
    },
  ];
}

function seedState(input: { agent: Agent; workspaces?: WorkspaceDescriptor[] }) {
  const agent = input.agent;
  aggregatedAgentsState.value = {
    agents: [toAggregatedAgent(agent)],
    isInitialLoad: false,
  };
  useSessionStore.getState().initializeSession(SERVER_ID, {} as unknown as DaemonClient);
  useSessionStore.getState().setAgents(SERVER_ID, new Map([[agent.id, agent]]));
  useSessionStore
    .getState()
    .setWorkspaces(
      SERVER_ID,
      new Map((input.workspaces ?? [workspace()]).map((entry) => [entry.id, entry])),
    );
}

beforeEach(() => {
  prepareWorkspaceTabMock.mockReset();
  navigateToPreparedWorkspaceTabMock.mockReset();
});

afterEach(() => {
  cleanup();
  useSessionStore.setState({ sessions: {}, agentLastActivity: new Map() });
});

describe("SidebarSessionsView row navigation", () => {
  it("prepares and navigates to the agent tab in the resolved workspace", () => {
    seedState({ agent: makeAgent() });

    const { getByTestId } = render(
      <SidebarSessionsView
        serverId={SERVER_ID}
        projects={projects()}
        filter={ALL_SESSIONS_FILTER}
        groupByProject={false}
        previewExpandedProjects={new Set()}
        collapsedProjectKeys={new Set()}
        onProjectPreviewExpandedToggle={vi.fn()}
        onProjectCollapsedToggle={vi.fn()}
      />,
    );

    fireEvent.click(getByTestId(`sidebar-session-row-${SERVER_ID}-${AGENT_ID}`));

    const navigationInput = {
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      target: { kind: "agent", agentId: AGENT_ID },
    };
    expect(prepareWorkspaceTabMock).toHaveBeenCalledTimes(1);
    expect(prepareWorkspaceTabMock).toHaveBeenCalledWith(navigationInput);
    expect(navigateToPreparedWorkspaceTabMock).toHaveBeenCalledTimes(1);
    expect(navigateToPreparedWorkspaceTabMock).toHaveBeenCalledWith(navigationInput);
    expect(prepareWorkspaceTabMock.mock.invocationCallOrder[0]).toBeLessThan(
      navigateToPreparedWorkspaceTabMock.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("does nothing when the row agent no longer resolves to a workspace", () => {
    seedState({ agent: makeAgent() });

    const { getByTestId } = render(
      <SidebarSessionsView
        serverId={SERVER_ID}
        projects={projects()}
        filter={ALL_SESSIONS_FILTER}
        groupByProject={false}
        previewExpandedProjects={new Set()}
        collapsedProjectKeys={new Set()}
        onProjectPreviewExpandedToggle={vi.fn()}
        onProjectCollapsedToggle={vi.fn()}
      />,
    );
    useSessionStore.getState().setWorkspaces(SERVER_ID, new Map());

    fireEvent.click(getByTestId(`sidebar-session-row-${SERVER_ID}-${AGENT_ID}`));

    expect(prepareWorkspaceTabMock).not.toHaveBeenCalled();
    expect(navigateToPreparedWorkspaceTabMock).not.toHaveBeenCalled();
  });
});
